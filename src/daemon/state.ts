import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import type { SessionInfo } from '../types';
import type { TelegramClient } from '../telegram';
import { log } from './logger';
import { MS_PER_DAY, SESSION_CLEANUP_DAYS } from '../constants';

// ============================================================
// STATE MANAGEMENT
// ============================================================

export interface DaemonState {
  sessions: Map<string, SessionInfo>;
  threadToSession: Map<string, string>;
  clients: Map<string, any>;
}

export function createState(statePath: string): DaemonState {
  const sessions = new Map<string, SessionInfo>();
  const threadToSession = new Map<string, string>();
  const clients = new Map<string, any>();

  // Load existing state from file
  if (existsSync(statePath)) {
    try {
      const data = JSON.parse(readFileSync(statePath, 'utf-8'));
      // Handle both old format (array of pairs [[id, info], ...]) and new format ({ id: info })
      const entries: [string, any][] = Array.isArray(data.sessions)
        ? data.sessions
        : Object.entries(data.sessions);
      let skipped = 0;
      for (const [id, info] of entries) {
        // Skip invalid or threadless sessions — they're ephemeral and will re-register
        if (!info.threadID || !id.startsWith('ses_')) {
          skipped++;
          continue;
        }
        info.pendingPermissions = new Map(info.pendingPermissions || []);
        info.pendingAsks = new Map(info.pendingAsks || []);
        info.messageQueue = info.messageQueue || [];
        info.messageIDs = info.messageIDs || [];
        sessions.set(id, info);
      }
      if (skipped > 0) {
        log(`Pruned ${skipped} session(s) without threads on load`, 'info');
      }

      // Rebuild threadToSession from sessions to fix potential collisions and migrate to composite keys
      // We ignore the saved threadToSession and regenerate it to ensure consistency
      for (const [id, session] of sessions) {
        if (session.threadID) {
          if (session.chatId) {
            // New format: chatId:threadID
            threadToSession.set(`${session.chatId}:${session.threadID}`, id);
          } else {
            // Legacy format: just threadID (as string)
            // This handles cases where chatId might be missing from old sessions
            threadToSession.set(String(session.threadID), id);
          }
        }
      }
    } catch (err) {
      log(`[Daemon] Failed to load state: ${err}`, 'error');
    }
  }

  return { sessions, threadToSession, clients };
}

export function saveState(state: DaemonState, statePath: string) {
  // Only persist sessions with threads — threadless sessions are ephemeral
  // threadToSession is rebuilt from sessions on load, no need to persist
  const sessions: Record<string, any> = {};
  for (const [id, session] of state.sessions) {
    if (session.threadID && id.startsWith('ses_')) {
      sessions[id] = session;
    }
  }
  const data = { sessions };

  // Use atomic write: write to .tmp file first, then rename
  // This prevents corruption if the process crashes mid-write
  const tmpPath = `${statePath}.tmp`;

  try {
    writeFileSync(
      tmpPath,
      JSON.stringify(
        data,
        (key, value) => {
          // Maps inside sessions (pendingPermissions, pendingAsks) still need conversion
          if (value instanceof Map) return Array.from(value.entries());
          return value;
        },
        2
      )
    );

    // Atomic rename - replaces the old file only after the new one is fully written
    renameSync(tmpPath, statePath);
  } catch (err) {
    log(`[Daemon] Failed to save state: ${err}`, 'error');
    throw err;
  }
}

export function sendToClient(clients: Map<string, any>, sessionID: string, msg: any): boolean {
  const socket = clients.get(sessionID);
  if (socket?.writable) {
    socket.write(JSON.stringify(msg) + '\n');
    return true;
  }
  return false;
}

/**
 * Clean up old disconnected sessions
 * Removes sessions that have been disconnected for more than SESSION_CLEANUP_DAYS
 */
export async function cleanupOldSessions(
  state: DaemonState,
  statePath: string,
  bot?: TelegramClient,
  chatId?: string
): Promise<number> {
  const now = Date.now();
  const maxAge = SESSION_CLEANUP_DAYS * MS_PER_DAY;
  let cleanedCount = 0;

  for (const [sessionID, session] of state.sessions.entries()) {
    // Only cleanup sessions that are disconnected and have a disconnectedAt timestamp
    if (session.status === 'disconnected' && session.disconnectedAt) {
      const age = now - session.disconnectedAt;
      if (age > maxAge) {
        log(
          `[Daemon] Auto-cleanup: removing session ${sessionID} (disconnected ${Math.floor(age / MS_PER_DAY)} days ago)`,
          'info'
        );

        // Delete the thread if it exists
        if (session.threadID && bot && session.chatId) {
          try {
            await bot.deleteForumTopic({
              chat_id: session.chatId,
              message_thread_id: session.threadID,
            });
            state.threadToSession.delete(`${session.chatId}:${session.threadID}`);
            state.threadToSession.delete(String(session.threadID));
          } catch (err) {
            log(`[Daemon] Failed to delete thread during auto-cleanup: ${err}`, 'warn');
          }
        }

        // Remove the session
        state.sessions.delete(sessionID);
        state.clients.delete(sessionID);
        cleanedCount++;
      }
    }
  }

  if (cleanedCount > 0) {
    saveState(state, statePath);
    log(`[Daemon] Auto-cleanup: removed ${cleanedCount} old disconnected session(s)`, 'info');
  }

  return cleanedCount;
}

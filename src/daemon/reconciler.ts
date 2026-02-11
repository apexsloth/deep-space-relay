/**
 * State Reconciler for Telegram Thread Management
 *
 * Replaces the reactive ensureThread + recoverStaleThread pattern with a
 * declarative reconciler. Internal state is the source of truth; reconcile()
 * ensures Telegram matches it — creating threads as needed.
 *
 * Design:
 *   - Main agents get threads eagerly (on register → reconcile)
 *   - Subagents remain lazy (thread on first send, NOT register)
 *   - Thread creation locks prevent concurrent creation for same session
 *   - Thread recovery is reactive: sendWithRecovery catches thread errors,
 *     calls clearThreadState + reconcile to recreate
 */

import { log } from './logger';
import type { TelegramClient } from '../telegram';
import type { SessionInfo } from '../types';
import { saveState, sendToClient, type DaemonState } from './state';
import { formatThreadTitle, renderStatusDashboard } from './utils';

/**
 * Check if an error indicates a deleted/invalid Telegram thread.
 */
export function isThreadError(err: unknown): boolean {
  const errStr = String(err).toLowerCase();
  return errStr.includes('message thread not found') ||
         errStr.includes('topic_deleted') ||
         errStr.includes('thread id is invalid') ||
         errStr.includes('thread not found');
}

// Track in-flight thread creation promises to prevent duplicates
const threadCreationLocks = new Map<string, Promise<number | undefined>>();

/**
 * Reconcile a session's Telegram thread state.
 *
 * Simple: if the session has a threadID, return it. If not, create one.
 * Thread recovery (deleted threads) is handled reactively by sendWithRecovery,
 * which calls clearThreadState + reconcile to recreate.
 *
 * @param sessionID   - The session to reconcile
 * @param state       - Daemon state
 * @param statePath   - Path to persist state
 * @param bot         - Telegram client
 * @param globalChatId - Daemon's global chatId (fallback when session has none)
 * @returns The threadID (existing or newly created), or undefined if creation failed
 */
export async function reconcile(
  sessionID: string,
  state: DaemonState,
  statePath: string,
  bot: TelegramClient,
  globalChatId: string,
): Promise<number | undefined> {
  const session = state.sessions.get(sessionID);
  if (!session) {
    log(`[Reconciler] Session ${sessionID} not found`, 'warn');
    return undefined;
  }

  const effectiveChatId = session.chatId || globalChatId;
  if (!effectiveChatId) {
    log(`[Reconciler] No chatId for session ${sessionID}`, 'warn');
    return undefined;
  }

  // Ensure session has the effective chatId stored
  if (!session.chatId) {
    session.chatId = effectiveChatId;
  }

  // Thread exists — trust it. Recovery happens in sendWithRecovery if it's stale.
  if (session.threadID) {
    return session.threadID;
  }

  // No threadID — create a new thread (with deduplication lock)
  return createThread(sessionID, state, statePath, bot, effectiveChatId);
}

/**
 * Clear all thread-related state for a session.
 * Used by sendWithRecovery when a thread is confirmed deleted/stale.
 */
export function clearThreadState(session: SessionInfo, state: DaemonState): void {
  if (session.threadID && session.chatId) {
    state.threadToSession.delete(`${session.chatId}:${session.threadID}`);
    state.threadToSession.delete(String(session.threadID));
  }
  session.threadID = undefined;
  session.statusMessageID = undefined;
}

/**
 * Create a new Telegram forum thread for a session.
 * Uses a lock map to prevent concurrent creation for the same session.
 */
async function createThread(
  sessionID: string,
  state: DaemonState,
  statePath: string,
  bot: TelegramClient,
  chatId: string,
): Promise<number | undefined> {
  // Check for in-flight creation
  const existingLock = threadCreationLocks.get(sessionID);
  if (existingLock) {
    log(`[Reconciler] Thread creation already in progress for ${sessionID}, waiting`, 'debug');
    return existingLock;
  }

  const creationPromise = (async () => {
    try {
      // Double-check after acquiring lock
      const session = state.sessions.get(sessionID);
      if (!session) return undefined;
      if (session.threadID) {
        log(`[Reconciler] Thread created while waiting for lock: ${sessionID}`, 'debug');
        return session.threadID;
      }

      const isSubagent = !!session.parentID;
      const threadName = formatThreadTitle(session.agentName, session.project, session.title, isSubagent);

      log(`[Reconciler] Creating thread for ${sessionID} title: ${threadName} chatId: ${chatId}`, 'info');
      const result = await bot.createForumTopic({ chat_id: chatId, name: threadName });
      if (!result.ok) {
        log(`[Reconciler] createForumTopic failed: ${JSON.stringify(result)}`, 'error');
        return undefined;
      }

      const threadID = result.result.message_thread_id;
      log(`[Reconciler] Thread created: ${threadID}`, 'info');

      session.threadID = threadID;
      session.chatId = chatId;
      state.threadToSession.set(`${chatId}:${threadID}`, sessionID);

      // Create and pin dashboard
      await reconcileDashboard(session, bot);

      saveState(state, statePath);
      sendToClient(state.clients, sessionID, { type: 'thread_created', threadID });

      return threadID;
    } catch (err) {
      log(`[Reconciler] Failed to create thread: ${err}`, 'error');
      return undefined;
    } finally {
      threadCreationLocks.delete(sessionID);
    }
  })();

  threadCreationLocks.set(sessionID, creationPromise);
  return creationPromise;
}

/**
 * Reconcile the dashboard message for a session.
 * Creates a new dashboard if none exists, or if the existing one was deleted.
 * Pins the dashboard message.
 */
export async function reconcileDashboard(
  session: SessionInfo,
  bot: TelegramClient,
): Promise<void> {
  if (!session.chatId || !session.threadID) return;

  const dashboardText = renderStatusDashboard(session);

  // If we have an existing dashboard, try to edit it
  if (session.statusMessageID) {
    try {
      const editResult = await bot.editMessageText({
        chat_id: session.chatId,
        message_id: session.statusMessageID,
        text: dashboardText,
        parse_mode: 'Markdown',
      });
      if (editResult.ok) return; // Dashboard updated successfully

      const desc = editResult.description || '';
      if (desc.includes('message is not modified')) return; // Already up to date
      // Message not found or other error — fall through to recreate
      log(`[Reconciler] Dashboard edit failed for ${session.sessionID}: ${desc}, recreating`, 'warn');
    } catch (err) {
      log(`[Reconciler] Dashboard edit error for ${session.sessionID}: ${err}, recreating`, 'warn');
    }
    // Clear stale dashboard reference
    session.statusMessageID = undefined;
  }

  // Create new dashboard
  try {
    const dashboardRes = await bot.sendMessage({
      chat_id: session.chatId,
      message_thread_id: session.threadID,
      text: dashboardText,
      parse_mode: 'Markdown',
    });
    if (dashboardRes.ok) {
      session.statusMessageID = dashboardRes.result.message_id;
      await bot.pinChatMessage({
        chat_id: session.chatId,
        message_id: session.statusMessageID,
        disable_notification: true,
      });
    }
  } catch (err) {
    log(`[Reconciler] Failed to create dashboard for ${session.sessionID}: ${err}`, 'warn');
  }
}

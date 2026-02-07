import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Plugin } from '@opencode-ai/plugin';
import { createRelay, type Relay } from './relay/index';
import { createTools } from './tools';
import { createEventHandler } from './events';
import { loadConfig, getSystemConfigDir, getSocketPath } from './config';
import type { PluginContext, LogFn } from './types';

// ============================================================
// PLUGIN
// ============================================================

// Extract project name from path (last non-empty segment)
const extractNameFromPath = (path?: string): string | undefined => {
  if (!path) return undefined;
  return path.split('/').filter(Boolean).pop();
};

export const DeepSpaceRelay: Plugin = async (ctx: PluginContext) => {
  const { directory, worktree, project, client } = ctx;
  // Priority: worktree name > project.worktree name > directory name > 'Project'
  // project.id is a git SHA hash, not useful for display
  const projectName =
    extractNameFromPath(worktree) ||
    extractNameFromPath(project?.worktree) ||
    extractNameFromPath(directory) ||
    'Project';

  const log: LogFn = (
    message: string,
    level: 'debug' | 'info' | 'warn' | 'error' = 'info',
    extra?: Record<string, unknown>
  ) => {
    client.app
      .log({ body: { service: 'deep-space-relay', level, message, extra } })
      .catch((err) => {
        // Log delivery failed - this is not critical, continue silently
        // Using console.error as fallback since plugin logging is unavailable
        console.error('[DSR Plugin] Failed to send log to OpenCode:', err);
      });
  };

  log('Plugin initialized', 'info', {
    directory,
    worktree,
    projectName,
    projectId: project?.id,
    projectWorktree: project?.worktree,
    ctxKeys: Object.keys(ctx),
  });

  // Load project-specific config (chatId from project, token from system)
  const dsrConfig = loadConfig(directory);
  const chatId = dsrConfig.chatId;

  if (chatId) {
    log('Loaded project chatId', 'info', { chatId });
  } else {
    log('No chatId configured for this project', 'warn', { directory });
  }

  // Create relay instances per session
  const relays = new Map<string, Relay>();

  const getRelay = (sessionId: string): Relay => {
    let relay = relays.get(sessionId);
    if (!relay) {
      log('Creating relay instance for session', 'info', { sessionID: sessionId });
      relay = createRelay({
        project: projectName,
        directory,
        chatId,
        ipcToken: dsrConfig.token,
        log,
        onMessage: async (text, isThread, messageID) => {
          // Format message with prefix based on context
          const prefix = isThread ? '[DSR DM (use dsr_send to reply)]' : '[DSR Broadcast]';
          const msgIdPart = messageID ? ` [msg_id: ${messageID}]` : '';
          const formattedText = `${prefix}${msgIdPart}: ${text}`;

          const r = getRelay(sessionId);
          const state = r.getState();

          // Fetch current session context (model + agent) to maintain continuity
          let currentModel: { providerID: string; modelID: string } | undefined;
          let currentAgent: string | undefined;
          try {
            const result = await client.session.messages({ path: { id: sessionId } });
            const messages = result.data || [];

            // Get agent from last user message
            const lastUserMessage = messages.filter((m: any) => m.info?.role === 'user').pop();
            if (lastUserMessage?.info?.agent) {
              currentAgent = lastUserMessage.info.agent;
            }

            // Get model from last assistant message
            const lastAssistantMessage = messages
              .filter((m: any) => m.info?.role === 'assistant')
              .pop();
            if (lastAssistantMessage?.info?.providerID && lastAssistantMessage?.info?.modelID) {
              currentModel = {
                providerID: lastAssistantMessage.info.providerID,
                modelID: lastAssistantMessage.info.modelID,
              };
            }
          } catch (err) {
            log('Failed to fetch session messages for context', 'debug', { error: String(err) });
          }

          client.session
            .prompt({
              path: { id: sessionId },
              body: {
                parts: [{ type: 'text', text: formattedText }],
                ...(currentModel && { model: currentModel }),
                ...(currentAgent && { agent: currentAgent }),
              },
              query: { directory },
            })
            .catch((err) => {
              log('Message injection failed', 'warn', {
                sessionID: sessionId,
                error: String(err),
              });
            });
        },
        onStop: () => {
          // User sent /stop from Telegram - abort the session
          log('Received /stop from Telegram, aborting session', 'info', { sessionID: sessionId });
          client.session
            .abort({
              path: { id: sessionId },
              query: { directory },
            })
            .catch((err) => {
              log('Session abort failed', 'warn', {
                sessionID: sessionId,
                error: String(err),
              });
            });
        },
      });
      relays.set(sessionId, relay);
    }
    return relay;
  };

  // Create tools and event handler using factory functions
  const tools = createTools(getRelay, log, relays, client, directory);
  const eventHandler = createEventHandler(getRelay, log, client, directory, projectName);

  return {
    tool: tools,
    event: eventHandler,
  };
};

export default DeepSpaceRelay;

// Re-export types for consumers
export type { Relay } from './relay/index';
export type { RelayConfig, RelayState, PluginContext, LogFn } from './types';

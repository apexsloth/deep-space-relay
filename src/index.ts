import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { Plugin } from '@opencode-ai/plugin';
import { createRelay, type Relay } from './relay/index';
import { createTools } from './tools';
import { createEventHandler } from './events';
import { createPermissionHandler } from './permissions';
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

const MAX_INJECTION_RETRIES = 20;
const BUSY_RETRY_BASE_DELAY_MS = 500;

function isSessionBusyError(error: unknown): boolean {
  const errorText = String(
    typeof error === 'string' ? error : JSON.stringify(error)
  ).toLowerCase();

  return (
    errorText.includes('busy') ||
    errorText.includes('already running') ||
    errorText.includes('in progress') ||
    errorText.includes('session is running')
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const DeepSpaceRelay = (async (ctx: PluginContext) => {
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
          try {
            // Format message with prefix based on context
            const prefix = isThread ? '[DSR DM (use dsr_send to reply)]' : '[DSR Broadcast]';
            const msgIdPart = messageID ? ` [msg_id: ${messageID}]` : '';
            const formattedText = `${prefix}${msgIdPart}: ${text}`;

            for (let attempt = 1; attempt <= MAX_INJECTION_RETRIES; attempt++) {
              // Fetch current session context (model + agent) to maintain continuity
              let currentModel: { providerID: string; modelID: string } | undefined;
              let currentAgent: string | undefined;
              try {
                const result = await client.session.messages({
                  path: { id: sessionId },
                  query: { directory },
                });

                if (result.error) {
                  log('Failed to fetch session messages for context', 'debug', {
                    sessionID: sessionId,
                    error: JSON.stringify(result.error),
                  });
                } else {
                  const messages = result.data || [];

                  // Get agent from last user message
                  const lastUserMessage = messages.filter((m: any) => m.info?.role === 'user').pop();
                  if (lastUserMessage?.info?.agent) {
                    currentAgent = lastUserMessage.info.agent as string;
                  }

                  // Get model from last assistant message
                  const lastAssistantMessage = messages
                    .filter((m: any) => m.info?.role === 'assistant')
                    .pop();
                  if (lastAssistantMessage?.info?.providerID && lastAssistantMessage?.info?.modelID) {
                    currentModel = {
                      providerID: lastAssistantMessage.info.providerID as string,
                      modelID: lastAssistantMessage.info.modelID as string,
                    };
                  }
                }
              } catch (err) {
                log('Failed to fetch session messages for context', 'debug', { error: String(err) });
              }

              const injectMessage = async (body: {
                parts: Array<{ type: 'text'; text: string }>;
                model?: { providerID: string; modelID: string };
                agent?: string;
              }) => {
                try {
                  const result = await client.session.prompt({
                    path: { id: sessionId },
                    body,
                    query: { directory },
                  });

                  if (result.error) {
                    return { success: false as const, error: result.error };
                  }

                  return { success: true as const };
                } catch (err) {
                  return {
                    success: false as const,
                    error: { name: 'PromptThrow', data: { message: String(err) } },
                  };
                }
              };

              const bodyWithContext = {
                parts: [{ type: 'text', text: formattedText }],
                ...(currentModel && { model: currentModel }),
                ...(currentAgent && { agent: currentAgent }),
              };

              const primary = await injectMessage(bodyWithContext);
              if (primary.success) {
                log('Injected Telegram message into session', 'info', {
                  sessionID: sessionId,
                  messageID,
                  isThread,
                  hadModel: !!currentModel,
                  hadAgent: !!currentAgent,
                  attempt,
                });
                return;
              }

              let finalError: unknown = primary.error;

              // Fall back to plain prompt injection if model/agent context was rejected.
              // Reliability is more important than preserving exact model/agent metadata.
              const hadContext = !!(currentModel || currentAgent);
              if (hadContext) {
                log('Message injection with context failed, retrying without model/agent', 'warn', {
                  sessionID: sessionId,
                  error: JSON.stringify(primary.error),
                  hadModel: !!currentModel,
                  hadAgent: !!currentAgent,
                  attempt,
                });
                const fallback = await injectMessage({ parts: [{ type: 'text', text: formattedText }] });
                if (fallback.success) {
                  log('Message injection fallback succeeded', 'info', {
                    sessionID: sessionId,
                    messageID,
                    isThread,
                    attempt,
                  });
                  return;
                }

                finalError = fallback.error;
                log('Message injection fallback failed', 'warn', {
                  sessionID: sessionId,
                  error: JSON.stringify(fallback.error),
                  attempt,
                });
              } else {
                log('Message injection failed', 'warn', {
                  sessionID: sessionId,
                  error: JSON.stringify(primary.error),
                  attempt,
                });
              }

              if (attempt >= MAX_INJECTION_RETRIES || !isSessionBusyError(finalError)) {
                return;
              }

              const retryDelay = BUSY_RETRY_BASE_DELAY_MS * attempt;
              log('Session busy during message injection, retrying', 'info', {
                sessionID: sessionId,
                messageID,
                attempt,
                retryDelay,
              });
              await new Promise((resolve) => setTimeout(resolve, retryDelay));
            }
          } catch (err) {
            log('Unhandled error while injecting Telegram message', 'warn', {
              sessionID: sessionId,
              messageID,
              error: String(err),
            });
          }
        },
        onCommand: async (command, messageID) => {
          log('Received command pass-through from Telegram', 'info', { sessionId, command });
          try {
            if (command === 'undo') {
              await client.session.revert({ path: { id: sessionId }, query: { directory } });
            } else if (command === 'redo') {
              await client.session.unrevert({ path: { id: sessionId }, query: { directory } });
            }
          } catch (err) {
            log('Command execution failed', 'warn', { sessionId, command, error: String(err) });
          }
        },
        onShell: async (command, messageID) => {
          log('Received shell pass-through from Telegram', 'info', { sessionId, command });
          try {
            await client.session.shell({
              path: { id: sessionId },
              body: { command },
              query: { directory },
            });
          } catch (err) {
            log('Shell execution failed', 'warn', { sessionId, command, error: String(err) });
          }
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
  const permissionHandler = createPermissionHandler(getRelay, log, relays, client, directory);

  // Auto-connect is DISABLED for now.
  // The session.list API returns all sessions for the directory, but there's no
  // way to determine which session is currently selected/active by the user.
  // Using time-based heuristics causes cross-contamination when multiple clients
  // run on the same project. Re-enable once the OpenCode plugin API exposes the
  // active/selected session for the current client instance.
  // See: https://github.com/anomalyco/opencode/issues/TBD

  return {
    tool: tools,
    event: eventHandler,
    'permission.ask': permissionHandler,
  };
}) as unknown as Plugin;

export default DeepSpaceRelay;

// Re-export types for consumers
export type { Relay } from './relay/index';
export type { RelayConfig, RelayState, PluginContext, LogFn } from './types';

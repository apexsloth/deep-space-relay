import { createRelay, type Relay } from './relay/index';
import { createTools } from './tools';
import { createEventHandler } from './events';
import { createPermissionHandler } from './permissions';
import { loadConfig } from './config';
import type { OpenCodePluginContext } from './opencode-types';
import type {
  EventRuntime,
  LogFn,
  PermissionRuntime,
  RuntimeSessionMessage,
  ToolRuntime,
} from './types';

const MAX_INJECTION_RETRIES = 20;
const BUSY_RETRY_BASE_DELAY_MS = 500;

const extractNameFromPath = (path?: string): string | undefined => {
  if (!path) return undefined;
  return path.split('/').filter(Boolean).pop();
};

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

function findLastMessageByRole(
  messages: RuntimeSessionMessage[],
  role: string
): RuntimeSessionMessage | undefined {
  return [...messages].reverse().find((message) => message.info?.role === role);
}

export function createOpenCodePlugin() {
  return async (ctx: OpenCodePluginContext) => {
    const { directory, worktree, project, client } = ctx;
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
          process.stderr.write(`[DSR Plugin] Failed to send log to OpenCode: ${String(err)}\n`);
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

    const dsrConfig = loadConfig(directory);
    const chatId = dsrConfig.chatId;

    if (chatId) {
      log('Loaded project chatId', 'info', { chatId });
    } else {
      log('No chatId configured for this project', 'warn', { directory });
    }

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
              const prefix = isThread ? '[DSR DM (use dsr_send to reply)]' : '[DSR Broadcast]';
              const msgIdPart = messageID ? ` [msg_id: ${messageID}]` : '';
              const formattedText = `${prefix}${msgIdPart}: ${text}`;

              for (let attempt = 1; attempt <= MAX_INJECTION_RETRIES; attempt++) {
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
                    const lastUserMessage = findLastMessageByRole(messages, 'user');
                    if (lastUserMessage?.info?.agent) {
                      currentAgent = lastUserMessage.info.agent as string;
                    }

                    const lastAssistantMessage = findLastMessageByRole(messages, 'assistant');
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
                const hadContext = !!(currentModel || currentAgent);
                if (hadContext) {
                  log('Message injection with context failed, retrying without model/agent', 'warn', {
                    sessionID: sessionId,
                    error: JSON.stringify(primary.error),
                    hadModel: !!currentModel,
                    hadAgent: !!currentAgent,
                    attempt,
                  });
                  const fallback = await injectMessage({
                    parts: [{ type: 'text', text: formattedText }],
                  });
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
          onCommand: async (command) => {
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
          onShell: async (command) => {
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

    const toolRuntime: ToolRuntime = {
      session: {
        get: client.session.get,
      },
    };
    const eventRuntime: EventRuntime = {
      session: {
        get: client.session.get,
        prompt: client.session.prompt,
        messages: client.session.messages,
      },
    };
    const permissionRuntime: PermissionRuntime = {
      postSessionIdPermissionsPermissionId: client.postSessionIdPermissionsPermissionId,
    };

    return {
      tool: createTools(getRelay, log, relays, toolRuntime, directory),
      event: createEventHandler(getRelay, log, eventRuntime, directory, projectName),
      'permission.ask': createPermissionHandler(
        getRelay,
        log,
        relays,
        permissionRuntime,
        directory
      ),
    };
  };
}

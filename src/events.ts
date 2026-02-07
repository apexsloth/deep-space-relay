import type { Relay } from './relay/core';
import type { LogFn, PluginContext } from './types';
import {
  IDLE_DEBOUNCE_MS,
  ABORT_GRACE_WINDOW_MS,
  MAX_COMPACTION_SUMMARY_LENGTH,
  MAX_IDLE_SUMMARY_LENGTH,
} from './constants';

// Debounce tracking for idle summaries (prevent spam on rapid busy->idle transitions)
const lastIdleSummary = new Map<string, number>();
// Track when aborts were detected per session (prevents phantom actions after abort)
const abortDetectedAt = new Map<string, number>();

/**
 * Check if an error represents a user-initiated abort/interrupt.
 * These are expected behaviors, not real errors.
 */
function isAbortError(error: unknown): boolean {
  if (!error) return false;

  // Handle error objects
  if (typeof error === 'object') {
    const errObj = error as Record<string, unknown>;
    const name = (errObj.name as string | undefined) ?? '';
    const message = (errObj.message as string | undefined) ?? '';
    const dataMessage = ((errObj.data as Record<string, unknown>)?.message as string) ?? '';
    const combined = `${name} ${message} ${dataMessage}`.toLowerCase();

    // Check for known abort error types
    if (name === 'MessageAbortedError' || name === 'AbortError') return true;
    if (name === 'DOMException' && combined.includes('abort')) return true;

    // Check for abort-related keywords in message
    const abortKeywords = ['aborted', 'cancelled', 'canceled', 'interrupted'];
    if (abortKeywords.some((kw) => combined.includes(kw))) return true;
  }

  // Handle string errors
  if (typeof error === 'string') {
    const lower = error.toLowerCase();
    return (
      lower.includes('abort') ||
      lower.includes('cancel') ||
      lower.includes('interrupt') ||
      lower.includes('messageabortederror')
    );
  }

  return false;
}

/**
 * Check if a session is within the abort grace window.
 * Returns true if we should skip processing (abort detected recently).
 */
function isInAbortGraceWindow(sessionId: string): boolean {
  const detectedAt = abortDetectedAt.get(sessionId);
  if (!detectedAt) return false;
  return Date.now() - detectedAt < ABORT_GRACE_WINDOW_MS;
}

/**
 * Mark that an abort was detected for this session.
 */
function markAbortDetected(sessionId: string): void {
  abortDetectedAt.set(sessionId, Date.now());
}

// ============================================================
// EVENT HANDLERS
// ============================================================

export function createEventHandler(
  getRelay: (sessionId: string) => Relay,
  log: LogFn,
  client: PluginContext['client'],
  directory: string,
  projectName: string
) {
  // Track which sessions are currently registering (prevents double-registration per session)
  const registeringSessions = new Set<string>();

  return async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
    const props = (event as any).properties as Record<string, unknown> | undefined;
    const info = props?.info as Record<string, unknown> | undefined;

    // Session ID can be in different places depending on event type:
    // - message.updated, session.updated: properties.info.sessionID or properties.info.id
    // - session.idle, session.status, session.error: properties.sessionID
    const sessionId =
      (info?.sessionID as string) || (props?.sessionID as string) || (info?.id as string);

    // Log events using the plugin logger
    log('Event received', 'debug', { type: event.type, sessionId, properties: props });

    // === session.created ===
    // === session.created ===
    if (event.type === 'session.created') {
      await handleSessionCreated(
        sessionId,
        info,
        props,
        event,
        getRelay,
        log,
        client,
        directory,
        projectName,
        registeringSessions
      );
    }

    // === session.idle ===
    if (event.type === 'session.idle') {
      await handleSessionIdle(
        sessionId,
        info,
        getRelay,
        log,
        client,
        directory,
        registeringSessions
      );
    }

    // === message.updated ===
    if (event.type === 'message.updated') {
      await handleMessageUpdated(
        sessionId,
        info,
        getRelay,
        log,
        client,
        directory,
        registeringSessions
      );
    }

    // === session.updated ===
    if (event.type === 'session.updated') {
      await handleSessionUpdated(sessionId, info, getRelay, log);
    }

    // === session.compacted ===
    if (event.type === 'session.compacted') {
      await handleSessionCompacted(sessionId, getRelay, log, client, directory);
    }

    // === session.status ===
    if (event.type === 'session.status') {
      await handleSessionStatus(sessionId, props, getRelay, log, client, directory);
    }

    // === session.error ===
    if (event.type === 'session.error') {
      await handleSessionError(sessionId, props, getRelay, log);
    }
  };
}

async function handleSessionCreated(
  sessionId: string | undefined,
  info: Record<string, unknown> | undefined,
  props: Record<string, unknown> | undefined,
  event: { type: string },
  getRelay: (sessionId: string) => Relay,
  log: LogFn,
  client: PluginContext['client'],
  directory: string,
  projectName: string,
  registeringSessions: Set<string>
) {
  // Skip subagents - they have a parentID
  if (info?.parentID) {
    log('Skipping subagent session', 'debug', { sessionId, parentID: info.parentID });
    return;
  }

  // Skip if no sessionId or this session is already registering
  if (!sessionId || registeringSessions.has(sessionId)) {
    return;
  }

  try {
    registeringSessions.add(sessionId);
    log('session.created - registering', 'info', {
      sessionID: sessionId,
      info,
      props,
      eventKeys: Object.keys(event),
    });
    const r = getRelay(sessionId);

    // Fetch session to get the actual title
    let title = `Session ${sessionId.slice(-8)}`;
    try {
      const sessionData = await client.session.get({
        path: { id: sessionId },
        query: { directory },
      });
      if (sessionData.data?.title) {
        title = sessionData.data.title;
      }
    } catch (err) {
      log('Failed to fetch session title', 'warn', {
        sessionID: sessionId,
        error: String(err),
      });
    }

    await r.register(sessionId, title);
    log('session.created register complete', 'info', { sessionID: sessionId });

    const welcomeText = `Deep Space Relay is active! 
- Use \`dsr_send\` to communicate with the user via Telegram.
- Incoming messages will be prefixed with [DSR DM (use dsr_send to reply)].
- **REACTION REQUIRED**: When you receive a message from the user, use \`dsr_react_to\` with a funny emoji (e.g. 🤖, 📺, 📡, 💾) to acknowledge you've read it!
- **NAME**: You've been assigned a random cult classic name! Use \`dsr_set_agent_name\` if you'd like a different creative name. Be unique to avoid collision with other agents!
- **TIP**: Multiple short messages are better than one very long text.`;

    client.session
      .prompt({
        path: { id: sessionId },
        body: { parts: [{ type: 'text', text: welcomeText }] },
        query: { directory },
      })
      .catch((err) => {
        log('Welcome message injection failed', 'warn', {
          sessionID: sessionId,
          error: String(err),
        });
      });
  } catch (err) {
    log('session.created register error', 'error', { error: String(err) });
  } finally {
    registeringSessions.delete(sessionId);
  }
}

async function handleSessionIdle(
  sessionId: string | undefined,
  info: Record<string, unknown> | undefined,
  getRelay: (sessionId: string) => Relay,
  log: LogFn,
  client: PluginContext['client'],
  directory: string,
  registeringSessions: Set<string>
) {
  // Skip if no sessionId or this session is already registering
  if (!sessionId || registeringSessions.has(sessionId)) {
    return;
  }

  const r = getRelay(sessionId);
  const state = r.getState();

  // Register if not already (handles resume case)
  if (!state.registered) {
    try {
      registeringSessions.add(sessionId);
      log('session.idle - registering on resume', 'info', { sessionID: sessionId });

      // Fetch session to get the actual title
      let title = (info?.agent as string) || `Session ${sessionId.slice(-8)}`;
      try {
        const sessionData = await client.session.get({
          path: { id: sessionId },
          query: { directory },
        });
        if (sessionData.data?.title) {
          title = sessionData.data.title;
        }
      } catch (err) {
        log('Failed to fetch session title', 'warn', {
          sessionID: sessionId,
          error: String(err),
        });
      }

      await r.register(sessionId, title);
    } finally {
      registeringSessions.delete(sessionId);
    }
  }
}

async function handleMessageUpdated(
  sessionId: string | undefined,
  info: Record<string, unknown> | undefined,
  getRelay: (sessionId: string) => Relay,
  log: LogFn,
  client: PluginContext['client'],
  directory: string,
  registeringSessions: Set<string>
) {
  const role = info?.role as string | undefined;
  const isUserMessage = role === 'user';

  // Skip if no sessionId, not a user message, or this session is already registering
  if (!sessionId || !isUserMessage || registeringSessions.has(sessionId)) {
    return;
  }

  const r = getRelay(sessionId);
  const state = r.getState();

  if (!state.registered) {
    try {
      registeringSessions.add(sessionId);
      log('message.updated - registering on first user message', 'info', {
        sessionID: sessionId,
      });

      // Fetch session to get the actual title
      let title = (info?.agent as string) || `Session ${sessionId.slice(-8)}`;
      try {
        const sessionData = await client.session.get({
          path: { id: sessionId },
          query: { directory },
        });
        if (sessionData.data?.title) {
          title = sessionData.data.title;
        }
      } catch (err) {
        log('Failed to fetch session title', 'warn', {
          sessionID: sessionId,
          error: String(err),
        });
      }

      await r.register(sessionId, title);
      // No welcome message - too spammy and clutters context
    } finally {
      registeringSessions.delete(sessionId);
    }
  }
}

async function handleSessionUpdated(
  sessionId: string | undefined,
  info: Record<string, unknown> | undefined,
  getRelay: (sessionId: string) => Relay,
  log: LogFn
) {
  const newTitle = info?.title as string | undefined;
  const sessionIdFromInfo = info?.id as string | undefined;
  if (sessionIdFromInfo && newTitle) {
    const r = getRelay(sessionIdFromInfo);
    const state = r.getState();

    // Only update if registered AND title has actually changed
    if (state.registered && newTitle !== state.title) {
      log('session.updated - title changed, updating thread title', 'info', {
        sessionID: sessionIdFromInfo,
        oldTitle: state.title,
        newTitle,
      });
      await r.updateTitle(newTitle);
    }
  }
}

async function handleSessionCompacted(
  sessionId: string | undefined,
  getRelay: (sessionId: string) => Relay,
  log: LogFn,
  client: PluginContext['client'],
  directory: string
) {
  log('session.compacted received', 'info', { sessionId });
  if (sessionId) {
    const r = getRelay(sessionId);
    const state = r.getState();

    // Skip if session was recently aborted
    if (isInAbortGraceWindow(sessionId)) {
      log('Skipping compaction summary (abort grace window)', 'debug', { sessionId });
      return;
    }

    if (state.registered && state.hasThread) {
      try {
        // Fetch messages to find the compaction summary
        const messages = await client.session.messages({
          path: { id: sessionId },
          query: { directory },
        });
        if (messages.data && messages.data.length > 0) {
          // Find the compaction message (agent: 'compaction', summary: true)
          const compactionMsg = [...messages.data]
            .reverse()
            .find((m: any) => m.info?.agent === 'compaction' || m.info?.summary === true);
          if (compactionMsg?.parts) {
            const textPart = compactionMsg.parts.find((p: any) => p.type === 'text');
            if (textPart?.text) {
              const summary =
                textPart.text.length > MAX_COMPACTION_SUMMARY_LENGTH
                  ? textPart.text.slice(0, MAX_COMPACTION_SUMMARY_LENGTH) + '...[truncated]'
                  : textPart.text;
              r.sendMessage(`**Session Compacted**\n\n${summary}`).catch((err) => {
                r.config.log(`Failed to send compaction summary: ${err}`, 'warn');
              });
              log('Sent compaction summary to Telegram', 'info', { sessionId });
            }
          } else {
            r.sendMessage('Session has been compacted. Context was summarized.').catch((err) => {
              r.config.log(`Failed to send compaction notice: ${err}`, 'warn');
            });
          }
        }
      } catch (err: any) {
        if (isAbortError(err) || String(err).includes('INVALID_NODE_TYPE_ERR')) {
          log('Suppressed expected error during compaction summary', 'debug', {
            sessionId,
            error: String(err),
          });
        } else {
          log('Failed to fetch compaction summary', 'warn', { sessionId, error: String(err) });
        }
      }
    }
  }
}

async function handleSessionStatus(
  sessionId: string | undefined,
  props: Record<string, unknown> | undefined,
  getRelay: (sessionId: string) => Relay,
  log: LogFn,
  client: PluginContext['client'],
  directory: string
) {
  const status = props?.status as { type: string } | undefined;
  log('session.status received', 'info', { sessionId, statusType: status?.type, props });
  if (sessionId && status?.type) {
    const r = getRelay(sessionId);
    const state = r.getState();
    if (state.registered) {
      if (status.type === 'busy') {
        log('Setting status to busy', 'info', { sessionId });
        r.setStatus('busy').catch((err) => {
          log(`Failed to set busy status: ${err}`, 'warn', { sessionId });
        });
      } else if (status.type === 'idle') {
        log('Setting status to idle', 'info', { sessionId });
        r.setStatus('idle').catch((err) => {
          log(`Failed to set idle status: ${err}`, 'warn', { sessionId });
        });

        // Only send idle summaries if the agent has already started a thread (i.e. has spoken)
        if (!state.hasThread) {
          log('Skipping idle summary (no thread yet)', 'debug', { sessionId });
          return;
        }

        // Skip if session was recently aborted (prevents phantom summaries after user interrupt)
        if (isInAbortGraceWindow(sessionId)) {
          log('Skipping idle summary (abort grace window)', 'debug', { sessionId });
          return;
        }

        // Debounce idle summaries to prevent spam on rapid busy->idle transitions
        const now = Date.now();
        const lastSent = lastIdleSummary.get(sessionId) || 0;
        if (now - lastSent < IDLE_DEBOUNCE_MS) {
          log('Skipping idle summary (debounced)', 'debug', {
            sessionId,
            timeSinceLast: now - lastSent,
          });
        } else {
          // Fetch the last meaningful message and send a summary to Telegram
          try {
            const messages = await client.session.messages({
              path: { id: sessionId },
              query: { directory },
            });
            if (messages.data && messages.data.length > 0) {
              // Find all meaningful messages (assistant or user)
              const meaningfulMsgs = [...messages.data].filter((m: any) => {
                const info = m.info || {};
                const role = info.role;

                // 1. Must be assistant or user
                if (role !== 'assistant' && role !== 'user') return false;

                // 2. Ignore internal agents/metadata
                if (info.agent === 'compaction' || info.summary === true) return false;
                if (info.internal === true || info.invisible === true || info.hidden === true)
                  return false;

                // 3. Check for meaningful text content
                const textParts = m.parts?.filter((p: any) => p.type === 'text' && p.text) || [];
                const combinedText = textParts
                  .map((p: any) => p.text)
                  .join('\n')
                  .trim();

                if (!combinedText) return false;

                // 4. Filter out system directives, reminders, and DSR internal messages
                const lowerText = combinedText.toLowerCase();
                if (
                  lowerText.includes('[system directive:') ||
                  lowerText.includes('<system-reminder>') ||
                  lowerText.includes('<environment_details>') ||
                  lowerText.includes('[dsr dm') ||
                  lowerText.includes('[dsr broadcast]') ||
                  lowerText.includes('deep space relay is active!') ||
                  lowerText.includes('name required: use `dsr_set_agent_name`')
                ) {
                  return false;
                }

                return true;
              });

              // Prefer the last ASSISTANT message to avoid echoing back user prompts
              const lastAssistantMsg = [...meaningfulMsgs]
                .filter((m: any) => m.info?.role === 'assistant')
                .pop();
              const lastMeaningfulMsg =
                lastAssistantMsg || meaningfulMsgs[meaningfulMsgs.length - 1];

              if (lastMeaningfulMsg?.parts) {
                const textParts = lastMeaningfulMsg.parts.filter(
                  (p: any) => p.type === 'text' && p.text
                );
                if (textParts.length > 0) {
                  const combinedText = textParts
                    .map((p: any) => p.text)
                    .join('\n')
                    .trim();

                  // Truncate if too long (Telegram has limits)
                  const summary =
                    combinedText.length > MAX_IDLE_SUMMARY_LENGTH
                      ? combinedText.slice(0, MAX_IDLE_SUMMARY_LENGTH) + '...[truncated]'
                      : combinedText;

                  const prefix =
                    lastMeaningfulMsg.info?.role === 'user' ? '**User asked:**\n\n' : '';
                  r.sendMessage(`**Status**\n\n${prefix}${summary}`).catch((err) => {
                    log(`Failed to send idle status summary: ${err}`, 'warn', { sessionId });
                  });
                  lastIdleSummary.set(sessionId, now);
                }
              }
            }
          } catch (err: any) {
            if (isAbortError(err) || String(err).includes('INVALID_NODE_TYPE_ERR')) {
              log('Suppressed expected error during idle summary', 'debug', {
                sessionId,
                error: String(err),
              });
            } else {
              log('Failed to fetch session messages on idle', 'warn', { error: String(err) });
            }
          }
        }
      }
    }
  }
}

async function handleSessionError(
  sessionId: string | undefined,
  props: Record<string, unknown> | undefined,
  getRelay: (sessionId: string) => Relay,
  log: LogFn
) {
  // Wrap everything in try-catch - if our handler throws, OpenCode displays it as error
  try {
    const error = props?.error as
      | { name?: string; message?: string; data?: { message?: string } }
      | undefined;
    if (!sessionId || !error) return;

    const errorName = error.name || 'Unknown Error';
    // Error message can be at error.message OR error.data.message
    const errorMessage = error.message || error.data?.message || 'No details available';

    // Check if this is an abort error using our centralized helper
    if (isAbortError(error)) {
      // Mark abort detected so subsequent events (like session.idle) know to skip
      markAbortDetected(sessionId);
      log('Abort detected, marked grace window', 'debug', { sessionId, errorName, errorMessage });
      return;
    }

    // Also check for other suppression patterns (legacy compatibility)
    const suppressPatterns = ['INVALID_NODE_TYPE_ERR'];
    const fullError = `${errorName} ${errorMessage}`.toLowerCase();
    if (suppressPatterns.some((p) => fullError.includes(p.toLowerCase()))) {
      log('Suppressed expected error', 'debug', { sessionId, errorName, errorMessage });
      return;
    }

    const r = getRelay(sessionId);
    const state = r.getState();
    if (state.registered) {
      // Send error notification to Telegram
      r.sendError(errorName, errorMessage).catch((err) => {
        log(`Failed to send error notification: ${err}`, 'warn', { sessionId, errorName });
      });
    }
  } catch (err) {
    // Silently log - NEVER let our handler throw back to OpenCode
    log('handleSessionError failed', 'warn', { sessionId, error: String(err) });
  }
}

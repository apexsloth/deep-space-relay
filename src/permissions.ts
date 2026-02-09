import type { Relay } from './relay/core';
import type { LogFn, PluginContext } from './types';

// ============================================================
// PERMISSION BRIDGE
// ============================================================
// Intercepts OpenCode's permission.ask hook to forward questions
// and permission requests to Telegram. The TUI also shows the
// dialog — whichever side answers first wins.

/**
 * Permission input matches the SDK's Permission type.
 * At runtime, `type` can be "permission" (tool approvals) or
 * potentially other values for different permission kinds.
 */
interface PermissionInput {
  id: string;
  type: string;
  pattern?: string | string[];
  sessionID: string;
  messageID: string;
  callID?: string;
  title: string;
  metadata: Record<string, unknown>;
  time: { created: number };
}

interface PermissionOutput {
  status: 'ask' | 'deny' | 'allow';
}

export function createPermissionHandler(
  getRelay: (sessionId: string) => Relay,
  log: LogFn,
  relays: Map<string, Relay>,
  client: PluginContext['client'],
  directory: string
) {
  return async (input: PermissionInput, output: PermissionOutput): Promise<void> => {
    // Leave output.status as 'ask' so TUI also shows the dialog.
    // We forward to Telegram in the background and respond via the
    // permission API when the Telegram user answers.

    const relay = relays.get(input.sessionID);
    if (!relay) {
      log('permission.ask: no relay for session', 'debug', {
        sessionID: input.sessionID,
        permissionID: input.id,
      });
      return;
    }

    const state = relay.getState();
    if (!state.registered) {
      log('permission.ask: session not registered', 'debug', {
        sessionID: input.sessionID,
        permissionID: input.id,
      });
      return;
    }

    log('permission.ask hook fired', 'info', {
      permissionID: input.id,
      type: input.type,
      title: input.title,
      sessionID: input.sessionID,
      metadataKeys: Object.keys(input.metadata || {}),
      metadata: input.metadata,
    });

    // Fire and forget — don't block the hook
    forwardPermissionToTelegram(input, relay, client, directory, log).catch(
      (err) => {
        log('Permission bridge error', 'warn', {
          error: String(err),
          permissionID: input.id,
        });
      }
    );
  };
}

/**
 * Forward a permission/question to Telegram and respond via the OpenCode API
 * when the user answers.
 */
async function forwardPermissionToTelegram(
  input: PermissionInput,
  relay: Relay,
  client: PluginContext['client'],
  directory: string,
  log: LogFn
): Promise<void> {
  // Check if this permission has selectable options (question-style).
  // OpenCode may store options in metadata under various keys.
  const options = extractOptions(input.metadata);

  if (options && options.length > 0) {
    // Question with options — use the ask flow (inline keyboard)
    await handleQuestionPermission(input, relay, client, directory, log, options);
  } else {
    // Regular permission — use approve/deny flow
    await handleToolPermission(input, relay, client, directory, log);
  }
}

/**
 * Handle a question-type permission by forwarding to Telegram as an inline
 * keyboard and responding with the selected option.
 */
async function handleQuestionPermission(
  input: PermissionInput,
  relay: Relay,
  client: PluginContext['client'],
  directory: string,
  log: LogFn,
  options: string[]
): Promise<void> {
  const question = input.title || 'Question from agent';

  log('Forwarding question to Telegram', 'info', {
    permissionID: input.id,
    question,
    optionCount: options.length,
  });

  const result = await relay.ask(question, options);

  if (result.success && result.selection) {
    try {
      await client.postSessionIdPermissionsPermissionId({
        path: { id: input.sessionID, permissionID: input.id },
        body: { response: result.selection },
        query: { directory },
      });
      log('Question answered via Telegram', 'info', {
        permissionID: input.id,
        selection: result.selection,
      });
    } catch (err) {
      // Permission may have already been resolved via TUI — not an error
      log('Question response failed (likely already resolved via TUI)', 'debug', {
        error: String(err),
        permissionID: input.id,
      });
    }
  } else {
    log('Question not answered from Telegram', 'debug', {
      permissionID: input.id,
      error: result.error,
    });
  }
}

/**
 * Handle a regular permission (tool approval) by forwarding to Telegram
 * with approve/deny buttons.
 */
async function handleToolPermission(
  input: PermissionInput,
  relay: Relay,
  client: PluginContext['client'],
  directory: string,
  log: LogFn
): Promise<void> {
  const toolName = input.type || 'unknown';
  const description = input.title || (input.pattern ? String(input.pattern) : undefined);

  log('Forwarding permission to Telegram', 'info', {
    permissionID: input.id,
    tool: toolName,
    description,
  });

  const result = await relay.askPermission(input.id, toolName, description);

  if (result.success && result.response) {
    // Map Telegram button response to permission API response
    const response = result.response === 'approve' ? 'once' : 'reject';
    try {
      await client.postSessionIdPermissionsPermissionId({
        path: { id: input.sessionID, permissionID: input.id },
        body: { response },
        query: { directory },
      });
      log('Permission responded via Telegram', 'info', {
        permissionID: input.id,
        telegramAction: result.response,
        apiResponse: response,
      });
    } catch (err) {
      // Permission may have already been resolved via TUI — not an error
      log('Permission response failed (likely already resolved via TUI)', 'debug', {
        error: String(err),
        permissionID: input.id,
      });
    }
  } else {
    log('Permission not answered from Telegram', 'debug', {
      permissionID: input.id,
      error: result.error,
    });
  }
}

/**
 * Extract options from permission metadata.
 * Tries common field names since the exact structure may vary.
 */
function extractOptions(metadata: Record<string, unknown>): string[] | null {
  if (!metadata) return null;

  // Try known field names
  for (const key of ['options', 'choices', 'items', 'selections']) {
    const value = metadata[key];
    if (Array.isArray(value) && value.length > 0) {
      // Ensure all items are strings
      return value.map((v) => String(v));
    }
  }

  return null;
}

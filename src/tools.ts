import { tool } from '@opencode-ai/plugin';
import type { Relay } from './relay/core';
import type { LogFn, PluginContext } from './types';
import { writeProjectConfig } from './config';

// ============================================================
// TOOL DEFINITIONS
// ============================================================

export function createTools(
  getRelay: (sessionId: string) => Relay,
  log: LogFn,
  relays: Map<string, Relay>,
  client: PluginContext['client'],
  directory: string
) {
  return {
    // Debug tool: manually register session with daemon (normally done automatically via hooks)
    dsr_debug_register: tool({
      description:
        'Debug tool to manually register this session with the Deep Space Relay daemon. Creates or reuses a Telegram thread. Normally automatic via hooks.',
      args: {
        sessionID: tool.schema.string(),
        title: tool.schema.string(),
      },
      async execute(args, ctx) {
        const sessionId = args.sessionID || (ctx as any)?.sessionID;
        const r = getRelay(sessionId);
        const result = await r.register(args.sessionID, args.title, ctx.abort);
        return result.success
          ? 'Registered with Deep Space Relay.'
          : `Failed to register: ${result.error}`;
      },
    }),

    // Debug tool: manually deregister session
    dsr_debug_deregister: tool({
      description:
        'Debug tool to deregister this session from the Deep Space Relay daemon. For testing/cleanup only.',
      args: {
        // NOTE: _placeholder is required because Gemini API needs at least one arg.
        _placeholder: tool.schema.boolean().describe('Placeholder. Always pass true.'),
      },
      async execute(_args, ctx) {
        const sessionId = (ctx as any)?.sessionID;
        if (!sessionId) return 'Error: No session ID available';
        const r = getRelay(sessionId);
        const result = await r.deregister(ctx.abort);
        return result.success
          ? 'Deregistered from Deep Space Relay.'
          : `Failed to deregister: ${result.error}`;
      },
    }),

    // Send DM to this session's thread
    dsr_send: tool({
      description: "Send a message to this session's Telegram thread (DM).",
      args: {
        text: tool.schema.string(),
      },
      async execute(args, ctx) {
        const sessionId = (ctx as any)?.sessionID;
        if (!sessionId) return 'Error: No session ID available';
        const r = getRelay(sessionId);
        const result = await r.send(args.text, ctx.abort);
        return result.success
          ? `Message sent to Telegram: ${args.text}`
          : `Failed to send: ${result.error}`;
      },
    }),

    // Broadcast to main channel
    dsr_broadcast: tool({
      description: 'Broadcast a message to the main Telegram channel (not a thread).',
      args: {
        text: tool.schema.string(),
      },
      async execute(args, ctx) {
        const sessionId = (ctx as any)?.sessionID;
        if (!sessionId) return 'Error: No session ID available';
        const r = getRelay(sessionId);
        const result = await r.broadcast(args.text, ctx.abort);
        return result.success
          ? `Broadcast sent to Telegram: ${args.text}`
          : `Failed to broadcast: ${result.error}`;
      },
    }),

    // Check status
    dsr_status: tool({
      description: 'Check the status of the Deep Space Relay connection.',
      args: {
        _placeholder: tool.schema.boolean().describe('Placeholder. Always pass true.'),
      },
      async execute(_args, ctx) {
        const sessionId = (ctx as any)?.sessionID;
        log('dsr_status called', 'debug', {
          sessionId,
          ctxKeys: Object.keys(ctx || {}),
          relayCount: relays.size,
          relayKeys: [...relays.keys()],
        });
        if (!sessionId) {
          return '<dsr_status>\nError: No session ID available\n</dsr_status>';
        }
        const relay = relays.get(sessionId);
        if (!relay) {
          return `<dsr_status>\nNot connected (no relay for session ${sessionId}, have: ${[...relays.keys()].join(', ') || 'none'})\n</dsr_status>`;
        }
        const status = relay.getStatus();
        const lines = [
          '<dsr_status>',
          `Connected: ${status.connected}`,
          `Registered: ${status.registered}`,
          `Session ID: ${status.sessionID ?? 'none'}`,
          `Chat ID: ${status.chatId ?? 'none'}`,
          `Project: ${status.project}`,
          `Directory: ${status.directory}`,
          '</dsr_status>',
        ];
        return lines.join('\n');
      },
    }),

    // Debug tool: delete a session and its thread
    dsr_debug_delete_session: tool({
      description: 'Debug tool to delete a session and its Telegram thread. For cleanup/testing.',
      args: {
        sessionID: tool.schema.string(),
      },
      async execute(args, ctx) {
        const sessionId = (ctx as any)?.sessionID || args.sessionID;
        const r = getRelay(sessionId);
        const result = await r.deleteSession(args.sessionID, ctx.abort);
        return result.success ? `Session ${args.sessionID} deleted.` : `Failed: ${result.error}`;
      },
    }),

    // Debug tool: send a permission request to Telegram
    dsr_debug_permission: tool({
      description: 'Debug tool to send a permission request to Telegram with approve/deny buttons.',
      args: {
        tool: tool.schema.string(),
        description: tool.schema.string().optional(),
      },
      async execute(args, ctx) {
        const sessionId = (ctx as any)?.sessionID;
        if (!sessionId) return 'Error: No session ID available';
        const r = getRelay(sessionId);
        const permissionID = `perm_${Date.now()}`;
        const result = await r.sendPermission(permissionID, args.tool, args.description, ctx.abort);
        return result.success
          ? `Permission request sent: ${permissionID}`
          : `Failed: ${result.error}`;
      },
    }),

    // Ask a question with options
    dsr_ask: tool({
      description:
        'Ask the user a question with a set of selection options (buttons). This will wait for the user to make a choice.',
      args: {
        question: tool.schema.string(),
        options: tool.schema.array(tool.schema.string()),
      },
      async execute(args, ctx) {
        const sessionId = (ctx as any)?.sessionID;
        if (!sessionId || typeof sessionId !== 'string') return 'Error: No session ID available';
        const r = getRelay(sessionId);
        const result = await r.ask(args.question, args.options, ctx.abort);
        return result.success ? `User selected: ${result.selection}` : `Failed: ${result.error}`;
      },
    }),

    // Set agent name
    dsr_set_agent_name: tool({
      description:
        'Set a custom name for yourself (e.g., a cute animation character). This name will be prepended to your messages in Telegram.',
      args: {
        name: tool.schema.string(),
      },
      async execute(args, ctx) {
        const sessionId = (ctx as any)?.sessionID;
        if (!sessionId) return 'Error: No session ID available';
        const r = getRelay(sessionId);

        // Also fetch and update the session title (might have been generated since session.created)
        let sessionTitle: string | undefined;
        try {
          const sessionData = await client.session.get({
            path: { id: sessionId },
            query: { directory },
            signal: ctx.abort,
          });
          sessionTitle = sessionData.data?.title;
        } catch (err) {
          log('Failed to fetch session title for agent name update', 'warn', {
            error: String(err),
          });
        }

        const result = await r.setAgentName(args.name, sessionTitle, ctx.abort);
        return result.success
          ? `Agent name set to: ${args.name}`
          : `Failed to set agent name: ${result.error}`;
      },
    }),

    // Typing indicator
    dsr_typing: tool({
      description:
        'Show a typing indicator in the Telegram thread to indicate the agent is working.',
      args: {
        _placeholder: tool.schema.boolean().describe('Placeholder. Always pass true.'),
      },
      async execute(_args, ctx) {
        const sessionId = (ctx as any)?.sessionID;
        if (!sessionId) return 'Error: No session ID available';
        const r = getRelay(sessionId);
        const result = await r.sendTyping();
        return result.success ? 'Typing indicator sent.' : `Failed: ${result.error}`;
      },
    }),

    // React
    dsr_react: tool({
      description: 'React to a message with an emoji.',
      args: {
        emoji: tool.schema.string(),
      },
      async execute(args, ctx) {
        const sessionId = (ctx as any)?.sessionID;
        if (!sessionId || typeof sessionId !== 'string') {
          log('dsr_react: invalid sessionID', 'warn', {
            sessionId,
            sessionIdType: typeof sessionId,
          });
          return 'Error: No session ID available';
        }
        const r = getRelay(sessionId);
        const result = await r.react(args.emoji);
        return result.success ? `Reacted with ${args.emoji}.` : `Failed: ${result.error}`;
      },
    }),

    // React to a specific message by ID
    dsr_react_to: tool({
      description:
        'React to a specific message with an emoji. If no messageID is provided, reacts to the last tracked message.',
      args: {
        emoji: tool.schema.string(),
        messageID: tool.schema.number().optional(),
      },
      async execute(args, ctx) {
        const sessionId = (ctx as any)?.sessionID;
        if (!sessionId || typeof sessionId !== 'string') {
          log('dsr_react_to: invalid sessionID', 'warn', {
            sessionId,
            sessionIdType: typeof sessionId,
          });
          return 'Error: No session ID available';
        }
        const r = getRelay(sessionId);
        const result = await r.reactTo(args.emoji, args.messageID);
        if (result.success) {
          return args.messageID
            ? `Reacted to message ${args.messageID} with ${args.emoji}.`
            : `Reacted with ${args.emoji}.`;
        }
        return `Failed: ${result.error}`;
      },
    }),

    // Reply to a specific message
    dsr_reply_to: tool({
      description:
        'Reply to a specific message by its message ID. The messageID is included in incoming messages as [msg_id: NNN].',
      args: {
        messageID: tool.schema.number(),
        text: tool.schema.string(),
      },
      async execute(args, ctx) {
        const sessionId = (ctx as any)?.sessionID;
        if (!sessionId) return 'Error: No session ID available';
        const r = getRelay(sessionId);
        const result = await r.replyTo(args.messageID, args.text, ctx.abort);
        return result.success
          ? `Replied to message ${args.messageID}: ${args.text}`
          : `Failed: ${result.error}`;
      },
    }),

    // Daemon health check
    dsr_daemon_health: tool({
      description:
        'Get health information from the Deep Space Relay daemon including uptime, session counts, memory usage, and Telegram connection status.',
      args: {
        _placeholder: tool.schema.boolean().describe('Placeholder. Always pass true.'),
      },
      async execute(_args, ctx) {
        const sessionId = (ctx as any)?.sessionID;
        // Try to get a relay - use existing or create temporary one
        let relay = sessionId ? relays.get(sessionId) : undefined;
        if (!relay) {
          // Create a temporary relay just for health check
          relay = getRelay(sessionId || 'health_check');
        }

        const health = await relay.getHealth(ctx.abort);
        if (!health.success) {
          return `<dsr_daemon_health>\nError: ${health.error}\n</dsr_daemon_health>`;
        }

        const lines = [
          '<dsr_daemon_health>',
          `PID: ${health.pid}`,
          `Uptime: ${health.uptime}`,
          '',
          'Telegram:',
          `  Connected: ${health.telegram?.connected}`,
          `  Bot: @${health.telegram?.botUsername}`,
          '',
          'Sessions:',
          `  Total: ${health.sessions?.total}`,
          `  Connected: ${health.sessions?.connected}`,
          `  Idle: ${health.sessions?.idle}`,
          `  Busy: ${health.sessions?.busy}`,
          `  Disconnected: ${health.sessions?.disconnected}`,
          '',
          `Threads: ${health.threads}`,
          '',
          'Memory:',
          `  Heap: ${health.memory?.heapUsedMB} MB`,
          `  RSS: ${health.memory?.rssMB} MB`,
          '</dsr_daemon_health>',
        ];
        return lines.join('\n');
      },
    }),

    // Switch to a different Telegram chat
    dsr_set_chat: tool({
      description:
        'Switch this session to a different Telegram chat/group. Creates a new thread in the target chat and persists the chatId to the project config so future sessions in this project use the same chat. The chatId should be a Telegram chat ID (e.g. "-1001234567890").',
      args: {
        chatId: tool.schema.string().describe('The Telegram chat ID to switch to (e.g. "-1001234567890")'),
      },
      async execute(args, ctx) {
        const sessionId = (ctx as any)?.sessionID;
        if (!sessionId) return 'Error: No session ID available';
        const r = getRelay(sessionId);

        // Persist to project config so future sessions use this chat
        try {
          writeProjectConfig(directory, { chatId: args.chatId });
        } catch (err) {
          log('Failed to write project config', 'warn', { error: String(err) });
          return `Failed to write config: ${String(err)}`;
        }

        // Tell daemon to switch this session's chat
        const result = await r.setChatId(args.chatId, ctx.abort);
        if (result.success) {
          return `Switched to chat ${args.chatId}. A new thread has been created in the target chat. Future sessions in this project will also use this chat.`;
        }
        return `Failed to switch chat: ${result.error}`;
      },
    }),
  };
}

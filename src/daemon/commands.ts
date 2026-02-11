import { log } from './logger';
import type { TelegramClient } from '../telegram';
import type { TelegramMessage, TelegramCallbackQuery, TelegramMessageReaction } from '../types';
import { saveState, sendToClient, type DaemonState } from './state';
import { handleSetAgentName } from './handlers';
import { addMessageID } from './utils';
import { TELEGRAM_CHAT_ID_PREFIX_LENGTH } from '../constants';

// ============================================================
// BOT COMMANDS AND EVENT HANDLERS
// ============================================================

export async function configureBot(bot: TelegramClient, chatId: string) {
  const commands = [
    { command: 'start', description: 'Configure/initialize the relay in a group' },
    { command: 'list', description: 'List active sessions with threads' },
    { command: 'list_all', description: 'List all sessions (including without threads)' },
    { command: 'agent', description: 'Show info / rename current agent' },
    { command: 'name', description: 'Rename agent: /name <new name>' },
    { command: 'cleanup', description: 'Delete stale threads for closed sessions' },
    { command: 'compact', description: 'Delete this thread (in thread) or thumbs up (global)' },
    { command: 'help', description: 'Show help and workflow ideas' },
    { command: 'all', description: 'Send a message to ALL connected agents' },
    { command: 'stop', description: 'Stop the current session' },
    { command: 'clear', description: 'Delete messages except last N (default 10): /clear [N]' },
  ];

  const checkResult = (name: string, result: any) => {
    if (!result.ok) {
      log(`[Bot Config] ${name} failed: ${result.description || JSON.stringify(result)}`, 'error');
    } else {
      log(`[Bot Config] ${name} succeeded`, 'info');
    }
    return result;
  };

  try {
    // Set bot profile
    const [nameResult, descResult, shortDescResult] = await Promise.all([
      bot.callApi('setMyName', { name: 'Deep Space Relay' }),
      bot.callApi('setMyDescription', {
        description: 'Deep Space Relay - Bridging AI Agent sessions to Telegram Forum Topics.',
      }),
      bot.callApi('setMyShortDescription', {
        short_description: 'Relay for OpenCode AI agent sessions to Telegram forum threads.',
      }),
    ]);
    checkResult('setMyName', nameResult);
    checkResult('setMyDescription', descResult);
    checkResult('setMyShortDescription', shortDescResult);

    // Set commands for default scope (private chats with bot)
    const defaultResult = await bot.callApi('setMyCommands', { commands });
    checkResult('setMyCommands (default)', defaultResult);

    // Set commands for all group chats (including forum groups)
    const groupResult = await bot.callApi('setMyCommands', {
      commands,
      scope: { type: 'all_group_chats' },
    });
    checkResult('setMyCommands (all_group_chats)', groupResult);

    // If we have a configured chat, set commands specifically for that chat
    if (chatId) {
      const chatResult = await bot.callApi('setMyCommands', {
        commands,
        scope: { type: 'chat', chat_id: chatId },
      });
      checkResult(`setMyCommands (chat ${chatId})`, chatResult);
    }
  } catch (err) {
    log(`[Bot Config] Unexpected error: ${err}`, 'error');
  }
}

import { ConfigManager } from './config-manager';

export function createMessageHandler(
  bot: TelegramClient,
  state: DaemonState,
  statePath: string,
  configManager: ConfigManager,
  getChatId: () => string,
  setChatId: (id: string) => void
) {
  let botUsername: string | null = null;
  bot
    .callApi('getMe', {})
    .then((res) => {
      if (res.ok) botUsername = res.result.username;
    })
    .catch((err) => {
      // Bot setup is non-critical at startup, log and continue
      log(`[Bot Config] Failed during bot configuration: ${err}`, 'warn');
    });

  return async (message: TelegramMessage) => {
    try {
      if (!message) {
        log('[Daemon] Received empty message', 'warn');
        return;
      }
      
      const chatId = getChatId();
      // Guard against missing chat object which would cause crash on access
      if (!message.chat || !message.chat.id) {
        log('[Daemon] Message missing chat information', 'warn', { msgId: message.message_id });
        return;
      }

      const msgChatId = String(message.chat.id);
      let text = message.text || '';
      const threadId = message.message_thread_id;

      log(`[Daemon] Incoming: "${text}"`, 'info', {
        chatId: msgChatId,
        threadId,
        msgId: message.message_id
      });

    // Strip bot username suffix (e.g., /list@BotName -> /list)
    if (botUsername && text.includes(`@${botUsername}`)) {
      text = text.replace(`@${botUsername}`, '').trim();
    }

    // Handle rename replies
    if (
      message.reply_to_message?.text?.includes('Please reply to this message with the new name')
    ) {
      const sid =
        state.threadToSession.get(`${msgChatId}:${threadId}`) ||
        state.threadToSession.get(String(threadId || 0));
      if (sid) {
        await handleSetAgentName(
          { name: text, sessionID: sid },
          null,
          { state, statePath, bot, chatId, ensureThread: async () => undefined },
          sid
        );
        await bot.sendMessage({
          chat_id: chatId,
          message_thread_id: threadId,
          text: `Agent renamed to **${text}**`,
          parse_mode: 'Markdown',
        });
      }
      return;
    }

    if (message.forum_topic_created || message.forum_topic_edited) {
      try {
        await bot.deleteMessage({ chat_id: msgChatId, message_id: message.message_id });
      } catch (err) {
        // Topic creation/edit message deletion is non-critical
        log(`[Commands] Failed to delete topic message: ${err}`, 'debug');
      }
      return;
    }

    if (!chatId && text === '/start') {
      setChatId(msgChatId);
      await configManager.updateConfig({ chatId: msgChatId });
      await bot.sendMessage({ chat_id: msgChatId, text: 'Deep Space Relay configured!' });
      return;
    }

    // Global commands should work regardless of whether chat has active sessions
    const globalCommands = ['/list', '/list_all', '/cleanup', '/all'];
    const isGlobalCommand = globalCommands.includes(text);

    // Daemon is a pure router - only accept messages from chats that have registered sessions
    // However, global commands should bypass this check
    if (!isGlobalCommand) {
      const isKnownProjectChat = Array.from(state.sessions.values()).some(
        (s) => String(s.chatId) === String(msgChatId)
      );
      if (!isKnownProjectChat) {
        log(`[Daemon] Ignoring message from unknown chat: ${msgChatId}`, 'info');
        return;
      }
    }

    if (text === '/stop' && threadId) {
      const sessionID =
        state.threadToSession.get(`${msgChatId}:${threadId}`) ||
        state.threadToSession.get(String(threadId));
      if (sessionID && sendToClient(state.clients, sessionID, { type: 'stop' })) {
        try {
          await bot.setMessageReaction({
            chat_id: msgChatId,
            message_id: message.message_id,
            reaction: [{ type: 'emoji', emoji: '\uD83D\uDC4D' }],
          });
        } catch (err) {
          // Reaction is non-critical
          log(`[Commands] Failed to react to /stop: ${err}`, 'debug');
        }
      }
      return;
    }

    if (text === '/cleanup') {
      let deleted = 0;
      const sessionsToDelete: string[] = [];
      for (const [sid, session] of state.sessions.entries()) {
        if (!state.clients.has(sid) && session.threadID && session.chatId) {
          try {
            await bot.deleteForumTopic({
              chat_id: session.chatId,
              message_thread_id: session.threadID,
            });
            state.threadToSession.delete(`${session.chatId}:${session.threadID}`);
            state.threadToSession.delete(String(session.threadID)); // Legacy cleanup
            sessionsToDelete.push(sid);
            deleted++;
          } catch (err) {
            // Thread deletion failed, log and continue with cleanup
            log(`[Commands] Failed to delete thread for session ${sid}: ${err}`, 'warn');
          }
        }
      }
      // Delete sessions after iteration to avoid modifying Map during iteration
      for (const sid of sessionsToDelete) {
        state.sessions.delete(sid);
      }
      if (deleted > 0) saveState(state, statePath);
      await bot.sendMessage({
        chat_id: msgChatId,
        text: `Cleaned up ${deleted} stale sessions and threads.`,
      });
      return;
    }

    if (text === '/compact') {
      if (!threadId) {
        // In global chat, just thumbs up
        try {
          await bot.setMessageReaction({
            chat_id: msgChatId,
            message_id: message.message_id,
            reaction: [{ type: 'emoji', emoji: '\uD83D\uDC4D' }],
          });
        } catch (err) {
          // Reaction is non-critical
          log(`[Commands] Failed to react to /compact: ${err}`, 'debug');
        }
        return;
      }
      // In a thread, delete the forum topic
      try {
        await bot.deleteForumTopic({ chat_id: msgChatId, message_thread_id: threadId });
        // Clean up state if this thread was tracked
        const sid =
          state.threadToSession.get(`${msgChatId}:${threadId}`) ||
          state.threadToSession.get(String(threadId));
        if (sid) {
          state.threadToSession.delete(`${msgChatId}:${threadId}`);
          state.threadToSession.delete(String(threadId)); // Legacy cleanup
          const session = state.sessions.get(sid);
          if (session) {
            session.threadID = undefined;
          }
          saveState(state, statePath);
        }
      } catch (err) {
        log(`[Daemon] Failed to delete forum topic: ${err}`, 'error');
      }
      return;
    }

    if (text.startsWith('/clear')) {
      if (!threadId) {
        await bot.sendMessage({
          chat_id: msgChatId,
          text: `Please use /clear inside an agent's thread. Usage: /clear [N]`,
        });
        return;
      }
      const sid =
        state.threadToSession.get(`${msgChatId}:${threadId}`) ||
        state.threadToSession.get(String(threadId));
      const session = sid ? state.sessions.get(sid) : null;
      if (!session) {
        await bot.sendMessage({
          chat_id: msgChatId,
          message_thread_id: threadId,
          text: 'Session info not found for this thread.',
        });
        return;
      }

      const args = text.split(' ');
      const limit = args[1] ? parseInt(args[1], 10) : 10;
      if (isNaN(limit) || limit < 0) {
        await bot.sendMessage({
          chat_id: msgChatId,
          message_thread_id: threadId,
          text: 'Invalid limit. Usage: `/clear [N]`',
          parse_mode: 'Markdown',
        });
        return;
      }

      // Delete the /clear command itself immediately
      try {
        await bot.setMessageReaction({
          chat_id: msgChatId,
          message_id: message.message_id,
          reaction: [{ type: 'emoji', emoji: '🧹' }],
        });
        await bot.deleteMessage({ chat_id: msgChatId, message_id: message.message_id });
      } catch (err) {
        // Ignore
      }

      const totalCount = session.messageIDs.length;
      const idsToDelete = totalCount > limit 
        ? session.messageIDs.slice(0, totalCount - limit).filter(id => id !== session.statusMessageID)
        : [];

      let deletedCount = 0;
      
      // Attempt to delete messages in parallel batches to speed up while staying rate-limit safe
      const batchSize = 5;
      for (let i = 0; i < idsToDelete.length; i += batchSize) {
        const batch = idsToDelete.slice(i, i + batchSize);
        await Promise.all(batch.map(async (id) => {
          try {
            const res = await bot.deleteMessage({ chat_id: msgChatId, message_id: id });
            if (res.ok) {
              deletedCount++;
            }
          } catch (err) {
            // Detect 48h limit error: "message can't be deleted for everyone"
            if (String(err).includes("can't be deleted")) {
              log(`[Commands] Message ${id} too old to delete`, 'debug');
            } else {
              log(`[Commands] Failed to delete message ${id}: ${err}`, 'debug');
            }
          }
        }));
      }

      // Update session message IDs
      session.messageIDs = session.messageIDs.filter(id => !idsToDelete.includes(id));
      
      saveState(state, statePath);
      return;

    }

    if (text === '/help') {
      const msg = [
        `🛸 **Deep Space Relay Help**`,
        ``,
        `**Commands:**`,
        `• /list - Show active sessions with threads.`,
        `• /list_all - Show all recorded sessions.`,
        `• /agent - Agent details + rename button.`,
        `• /cleanup - Remove threads for disconnected agents.`,
        `• /stop - Force stop the agent in this thread.`,
        ``,
        `📜 **The Live Grimoire Concept**`,
        `The relay is designed to turn your forum thread into a real-time progress grimoire.`,
        `1. **Pinned Status**: The agent can pin a message to track its current checklist.`,
        `2. **Real-time Streaming**: Incoming chunks show you the agent's "thinking" live.`,
        `3. **Voice Control**: Send a voice note for hands-free instructions.`,
        ``,
        `Pick a name from the **Final Space or sci-fi cult classics** to get started!`,
      ].join('\n');
      await bot.sendMessage({
        chat_id: chatId,
        message_thread_id: threadId,
        text: msg,
        parse_mode: 'Markdown',
      });
      return;
    }

    if (text === '/agent') {
      if (!threadId) {
        await bot.sendMessage({
          chat_id: chatId,
          text: `Please use /agent inside an agent's thread to see specific info.`,
        });
        return;
      }
      const sid =
        state.threadToSession.get(`${msgChatId}:${threadId}`) ||
        state.threadToSession.get(String(threadId));
      const session = sid ? state.sessions.get(sid) : null;
      if (!session) {
        await bot.sendMessage({
          chat_id: chatId,
          message_thread_id: threadId,
          text: 'Session info not found for this thread.',
        });
        return;
      }

      const msg = [
        `**Agent Info**`,
        ``,
        `**Name:** ${session.agentName || 'Unnamed Agent'}`,
        `**Project:** ${session.project}`,
        `**Status:** ${session.status || 'idle'}`,
        ...(session.model ? [`**Model:** \`${session.model}\``] : []),
        ...(session.agentType ? [`**Agent:** ${session.agentType}`] : []),
        `**Session ID:** \`${session.sessionID}\``,
      ].join('\n');
      await bot.sendMessage({
        chat_id: chatId,
        message_thread_id: threadId,
        text: msg,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '✏️ Rename Agent', callback_data: `trigger_rename:${sid}` }]],
        },
      });
      return;
    }

    if (text.startsWith('/name')) {
      if (!threadId) {
        await bot.sendMessage({
          chat_id: chatId,
          text: `Please use /name inside an agent's thread. Usage: /name <new name>`,
        });
        return;
      }
      const newName = text.replace('/name', '').trim();
      if (!newName) {
        await bot.sendMessage({
          chat_id: chatId,
          message_thread_id: threadId,
          text: 'Usage: `/name <new name>`',
          parse_mode: 'Markdown',
        });
        return;
      }
      const sid =
        state.threadToSession.get(`${msgChatId}:${threadId}`) ||
        state.threadToSession.get(String(threadId));
      if (sid) {
        await handleSetAgentName(
          { name: newName, sessionID: sid },
          null,
          { state, statePath, bot, chatId, ensureThread: async () => undefined },
          sid
        );
        await bot.sendMessage({
          chat_id: chatId,
          message_thread_id: threadId,
          text: `Agent renamed to **${newName}**`,
          parse_mode: 'Markdown',
        });
      } else {
        await bot.sendMessage({
          chat_id: chatId,
          message_thread_id: threadId,
          text: 'No session found for this thread.',
        });
      }
      return;
    }

    if (text === '/list' || text === '/list_all') {
      log(`[Daemon] Processing ${text} command`, 'info');
      const showAll = text === '/list_all';
      // /list: only main agents (no subagents) with threads
      // /list_all: everything including subagents and threadless sessions
      const sessionsWithThreads = [...state.sessions.entries()].filter(
        ([_, s]) => s.threadID && !s.parentID
      );
      const sessionsToShow = showAll ? [...state.sessions.entries()] : sessionsWithThreads;

      if (sessionsToShow.length === 0) {
        const msg = showAll
          ? 'No agent sessions.'
          : 'No sessions with threads. Use /list_all to see all.';
        await bot.sendMessage({ chat_id: msgChatId, message_thread_id: threadId, text: msg });
        return;
      }

      const lines = [showAll ? 'All Agent Sessions:' : 'Active Agents:', ''];
      const strippedChatId = chatId.startsWith('-100')
        ? chatId.slice(TELEGRAM_CHAT_ID_PREFIX_LENGTH)
        : chatId;
      for (const [sid, session] of sessionsToShow) {
        const isConnected = state.clients.has(sid);
        const prefix = session.parentID ? '\uD83E\uDDF5' : '';
        const status = isConnected ? '\uD83D\uDFE2' : '\uD83D\uDC7B';
        const agentName = session.agentName || 'Agent';
        const safeProject = session.project || 'unknown';
        const safeTitle = session.title || 'untitled';
        const threadLink = session.threadID
          ? `https://t.me/c/${strippedChatId}/${session.threadID}`
          : '';
        lines.push(
          `${status} ${prefix}${prefix ? ' ' : ''}${agentName} - ${safeProject}: ${safeTitle}`
        );
        if (threadLink) lines.push(`   → ${threadLink}`);
        else if (showAll) lines.push(`   (no thread)`);
      }

      if (!showAll && state.sessions.size > sessionsWithThreads.length) {
        const hiddenCount = state.sessions.size - sessionsWithThreads.length;
        lines.push(
          '',
          `${hiddenCount} more session(s) hidden (subagents / no thread). Use /list_all to see all.`
        );
      }

      const msg = lines.join('\n');
      await bot.sendMessage({
        chat_id: msgChatId,
        message_thread_id: threadId,
        text: msg,
        parse_mode: 'Markdown',
      });
      return;
    }

    // /all <message> — send to ALL connected agents, including threadless ones
    if (text.startsWith('/all ') && !threadId) {
      const allText = text.slice(5).trim();
      if (!allText) return;
      let sent = 0;
      for (const sid of state.clients.keys()) {
        const session = state.sessions.get(sid);
        if (String(session?.chatId) === String(msgChatId)) {
          sendToClient(state.clients, sid, {
            type: 'message',
            text: allText,
            isThread: false,
            messageID: message.message_id,
          });
          sent++;
        }
      }
      try {
        await bot.setMessageReaction({
          chat_id: msgChatId,
          message_id: message.message_id,
          reaction: [{ type: 'emoji', emoji: '\uD83D\uDCE2' }],
        });
      } catch (err) {
        log(`[Commands] Failed to react to /all: ${err}`, 'debug');
      }
      log(`[Commands] /all sent to ${sent} agents`, 'info');
      return;
    }

    if (!threadId) {
      // Broadcast only to active main agents (with threads, no subagents) in this chat.
      // Subagents don't receive General topic chatter.
      // Use /all to reach every connected agent including subagents.
      for (const sid of state.clients.keys()) {
        const session = state.sessions.get(sid);
        if (
          String(session?.chatId) === String(msgChatId) &&
          session?.threadID &&
          !session?.parentID
        ) {
          sendToClient(state.clients, sid, {
            type: 'message',
            text,
            isThread: false,
            messageID: message.message_id,
          });
        }
      }
    } else {
      const sid =
        state.threadToSession.get(`${msgChatId}:${threadId}`) ||
        state.threadToSession.get(String(threadId));
      log('[Daemon] Dispatch lookup:', 'debug', {
        threadId,
        sid,
        hasClients: state.clients.size,
        threadToSessionSize: state.threadToSession.size,
      });
      if (sid) {
        // Acknowledge message receipt immediately for better UX
        try {
          await bot.setMessageReaction({
            chat_id: msgChatId,
            message_id: message.message_id,
            reaction: [{ type: 'emoji', emoji: '✉️' }],
          });
        } catch (err) {
          // Reaction is non-critical
          log(`[Commands] Failed to acknowledge message: ${err}`, 'debug');
        }

        const session = state.sessions.get(sid);
        if (session) {
          session.lastMessageID = message.message_id;
          addMessageID(session, message.message_id);

          // Handle bang commands (!ls)
          if (text.startsWith('!')) {
            const shellCmd = text.slice(1).trim();
            if (shellCmd) {
              log(`[Commands] Forwarding shell command to client: ${shellCmd}`, 'info', { sid });
              if (
                sendToClient(state.clients, sid, {
                  type: 'shell',
                  command: shellCmd,
                  messageID: message.message_id,
                })
              ) {
                try {
                  await bot.setMessageReaction({
                    chat_id: msgChatId,
                    message_id: message.message_id,
                    reaction: [{ type: 'emoji', emoji: '⌛' }],
                  });
                } catch (err) {
                  log(`[Commands] Failed to react to shell cmd: ${err}`, 'debug');
                }
                return;
              } else {
                log(`[Commands] Failed to forward shell command: no connected client for ${sid}`, 'warn');
              }
            }
          }

          // Handle undo/redo pass-through
          if (text === '/undo' || text === '/redo') {
            const cmd = text.slice(1);
            log(`[Commands] Forwarding ${cmd} command to client`, 'info', { sid });
            if (
              sendToClient(state.clients, sid, {
                type: 'command',
                command: cmd,
                messageID: message.message_id,
              })
            ) {
              try {
                await bot.setMessageReaction({
                  chat_id: msgChatId,
                  message_id: message.message_id,
                  reaction: [{ type: 'emoji', emoji: '↩️' }],
                });
              } catch (err) {
                log(`[Commands] Failed to react to ${text}: ${err}`, 'debug');
              }
              return;
            } else {
              log(`[Commands] Failed to forward ${cmd} command: no connected client for ${sid}`, 'warn');
            }
          }

          if (
            !sendToClient(state.clients, sid, {
              type: 'message',
              text,
              isThread: true,
              messageID: message.message_id,
            })
          ) {
            session.messageQueue.push(text);
          }
          saveState(state, statePath);
        }
      }
    }
    } catch (err) {
      log(`[Daemon] Error processing message: ${err}`, 'error', { messageId: message?.message_id });
    }
  };
}

export function createCallbackQueryHandler(
  bot: TelegramClient,
  state: DaemonState,
  statePath: string
) {
  return async (query: TelegramCallbackQuery) => {
    const data = query.data || '';
    const parts = data.split(':');

    if (['approve', 'deny', 'always', 'never'].includes(parts[0])) {
      const action = parts[0];
      const permissionID = parts[1];
      let sessionID: string | undefined;
      for (const [sid, s] of state.sessions.entries()) {
        if (s.pendingPermissions?.has(permissionID)) {
          sessionID = sid;
          break;
        }
      }

      if (sessionID) {
        const session = state.sessions.get(sessionID)!;
        session.pendingPermissions.delete(permissionID);
        saveState(state, statePath);
        sendToClient(state.clients, sessionID, {
          type: 'permission_response',
          permissionID,
          action,
        });
        try {
          await bot.editMessageReplyMarkup({
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            reply_markup: { inline_keyboard: [] },
          });
          await bot.answerCallbackQuery({
            callback_query_id: query.id,
            text: `Permission ${action}ed`,
          });
        } catch (err) {
          // UI update failed, log but permission response was already sent
          log(`[Commands] Failed to update permission UI: ${err}`, 'warn');
        }
      }
      return;
    }

    if (parts[0] === 'ask') {
      const askID = parts[1];
      const selection = parts.slice(2).join(':');
      let sessionID: string | undefined;
      for (const [sid, s] of state.sessions.entries()) {
        if (s.pendingAsks?.has(askID)) {
          sessionID = sid;
          break;
        }
      }

      if (sessionID) {
        const session = state.sessions.get(sessionID)!;
        session.pendingAsks.delete(askID);
        saveState(state, statePath);
        sendToClient(state.clients, sessionID, { type: 'ask_response', askID, selection });
        try {
          await bot.editMessageText({
            chat_id: query.message.chat.id,
            message_id: query.message.message_id,
            text: `${query.message.text}\n\n*Selected:* ${selection}`,
            parse_mode: 'Markdown',
          });
          await bot.answerCallbackQuery({
            callback_query_id: query.id,
            text: `Selected: ${selection}`,
          });
        } catch (err) {
          // UI update failed, log but selection was already sent
          log(`[Commands] Failed to update ask UI: ${err}`, 'warn');
        }
      }
      return;
    }

    if (parts[0] === 'trigger_rename') {
      const sid = parts[1];
      const session = state.sessions.get(sid);
      if (session) {
        try {
          await bot.sendMessage({
            chat_id: query.message.chat.id,
            message_thread_id: query.message.message_thread_id,
            text: `Please reply to this message with the new name for agent [${session.agentName || 'Unnamed'}]:`,
            reply_markup: { force_reply: true, selective: true },
          });
          await bot.answerCallbackQuery({ callback_query_id: query.id });
        } catch (err) {
          // Rename prompt failed, log error
          log(`[Commands] Failed to send rename prompt: ${err}`, 'warn');
        }
      }
      return;
    }
  };
}

export function createReactionHandler(state: DaemonState) {
  return async (reaction: TelegramMessageReaction) => {
    const messageId = reaction.message_id;
    const newReactions = reaction.new_reaction;
    for (const [sid, session] of state.sessions.entries()) {
      if (session.messageIDs.includes(messageId)) {
        const emoji = newReactions[0]?.type === 'emoji' ? newReactions[0].emoji : null;
        if (emoji) {
          sendToClient(state.clients, sid, {
            type: 'message',
            text: `[Reaction: ${emoji} from ${reaction.user?.first_name || 'User'} on msg_id: ${messageId}]`,
            isThread: true,
            messageID: messageId,
          });
        }
        break;
      }
    }
  };
}

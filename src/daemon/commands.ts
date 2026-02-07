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
    { command: 'cleanup', description: 'Delete stale threads for closed sessions' },
    { command: 'compact', description: 'Delete this thread (in thread) or thumbs up (global)' },
    { command: 'help', description: 'Show help and workflow ideas' },
    { command: 'stop', description: 'Stop the current session' },
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
    const chatId = getChatId();
    log(`[Daemon] Incoming message: ${message.text}`, 'info', {
      chatId: message.chat.id,
      threadId: message.message_thread_id,
    });
    const msgChatId = String(message.chat.id);
    let text = message.text || '';
    const threadId = message.message_thread_id;

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

    // Daemon is a pure router - only accept messages from chats that have registered sessions
    const isKnownProjectChat = Array.from(state.sessions.values()).some(
      (s) => String(s.chatId) === String(msgChatId)
    );
    if (!isKnownProjectChat) {
      log(`[Daemon] Ignoring message from unknown chat: ${msgChatId}`, 'info');
      return;
    }

    if (text === '/stop' && threadId) {
      const sessionID =
        state.threadToSession.get(`${msgChatId}:${threadId}`) ||
        state.threadToSession.get(String(threadId));
      if (sessionID && sendToClient(state.clients, sessionID, { type: 'stop' })) {
        try {
          await bot.setMessageReaction({
            chat_id: chatId,
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
      for (const [sid, session] of state.sessions.entries()) {
        if (!state.clients.has(sid) && session.threadID && session.chatId) {
          try {
            await bot.deleteForumTopic({
              chat_id: session.chatId,
              message_thread_id: session.threadID,
            });
            state.threadToSession.delete(`${session.chatId}:${session.threadID}`);
            state.threadToSession.delete(String(session.threadID)); // Legacy cleanup
            state.sessions.delete(sid);
            deleted++;
          } catch (err) {
            // Thread deletion failed, log and continue with cleanup
            log(`[Commands] Failed to delete thread for session ${sid}: ${err}`, 'warn');
          }
        }
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
        `👤 **Agent Info**`,
        ``,
        `**Name:** ${session.agentName || 'Unnamed Agent'}`,
        `**Project:** ${session.project}`,
        `**Status:** ${session.status || 'idle'}`,
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

    if (text === '/list' || text === '/list_all') {
      log(`[Daemon] Processing ${text} command`, 'info');
      const showAll = text === '/list_all';
      const sessionsWithThreads = [...state.sessions.entries()].filter(([_, s]) => s.threadID);
      const sessionsToShow = showAll ? [...state.sessions.entries()] : sessionsWithThreads;

      if (sessionsToShow.length === 0) {
        const msg = showAll
          ? 'No agent sessions.'
          : 'No sessions with threads. Use /list_all to see all.';
        await bot.sendMessage({ chat_id: msgChatId, message_thread_id: threadId, text: msg });
        return;
      }

      const lines = [showAll ? 'All Agent Sessions:' : 'Active Sessions (with threads):', ''];
      const strippedChatId = chatId.startsWith('-100')
        ? chatId.slice(TELEGRAM_CHAT_ID_PREFIX_LENGTH)
        : chatId;
      for (const [sid, session] of sessionsToShow) {
        const isConnected = state.clients.has(sid);
        const prefix = /subagent|task/i.test(session.title) ? '\uD83E\uDDF5' : '';
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
        lines.push(
          '',
          `${state.sessions.size - sessionsWithThreads.length} sessions without threads. Use /list_all to see all.`
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

    if (!threadId) {
      // Broadcast only to sessions that belong to this chat
      for (const sid of state.clients.keys()) {
        const session = state.sessions.get(sid);
        if (String(session?.chatId) === String(msgChatId)) {
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
        const session = state.sessions.get(sid);
        if (session) {
          session.lastMessageID = message.message_id;
          addMessageID(session, message.message_id);
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

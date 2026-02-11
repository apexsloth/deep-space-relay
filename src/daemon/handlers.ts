import { log } from './logger';
import type { TelegramClient } from '../telegram';
import type { SessionInfo } from '../types';
import { saveState, sendToClient, type DaemonState } from './state';
import { AGENT_NAMES, getRandomAgentName, getSubagentName, formatThreadTitle, addMessageID, syncStatusDashboard } from './utils';
import {
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
  SECONDS_PER_HOUR,
  BYTES_PER_KB,
  KB_PER_MB,
} from '../constants';

export interface MessageHandlerContext {
  state: DaemonState;
  statePath: string;
  bot: TelegramClient;
  chatId: string; // Daemon's global chatId (fallback)
  ensureThread: (
    sessionID: string,
    project: string,
    title: string,
    chatId?: string
  ) => Promise<number | undefined>;
}

async function recoverStaleThread(
  err: any,
  session: SessionInfo,
  ctx: MessageHandlerContext,
  sessionID: string
): Promise<boolean> {
  if (!session.threadID) return false;

  const errStr = String(err);
  const isThreadNotFound = errStr.includes('message thread not found');
  const chatIdChanged = !!(session.chatId && ctx.chatId && session.chatId !== ctx.chatId);

  // Recover if thread was deleted on Telegram side, OR if the daemon's chatId
  // changed in config (session still points to the old chat's thread)
  if (!isThreadNotFound && !chatIdChanged) return false;

  const reason = isThreadNotFound
    ? 'thread not found'
    : `chatId changed (${session.chatId} -> ${ctx.chatId})`;
  log(`[Daemon] Thread ${session.threadID} stale for ${sessionID} (${reason}), recreating`, 'warn');

  // Clear old thread mapping (both composite and legacy keys)
  ctx.state.threadToSession.delete(`${session.chatId}:${session.threadID}`);
  ctx.state.threadToSession.delete(String(session.threadID));
  session.threadID = undefined;

  // Update chatId to current config value if it changed
  if (chatIdChanged) {
    log(`[Daemon] Migrating session chatId: ${session.chatId} -> ${ctx.chatId}`, 'info');
    session.chatId = ctx.chatId;
  }

  saveState(ctx.state, ctx.statePath);
  // Create new thread in the (potentially updated) chat
  await ctx.ensureThread(sessionID, session.project, session.title, session.chatId);
  return true;
}

export async function handleRegister(
  msg: any,
  socket: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
): Promise<string | null> {
  const { state, statePath, bot, chatId } = ctx;
  const sid = msg.sessionID;
  const correlationId = msg.correlationId;
  if (sid) {
    state.clients.set(sid, socket);
    // Use project/title/chatId from message, fallback to existing session values or defaults
    const existing = state.sessions.get(sid);
    const isSubagent = !!msg.parentID;
    const session: SessionInfo = existing || {
      sessionID: sid,
      project: msg.project || 'Project',
      title: msg.title || 'Session',
      chatId: msg.chatId || chatId, // Per-session chatId, fallback to daemon chatId
      parentID: msg.parentID, // Track parent for subagents
      agentName: isSubagent
        ? getSubagentName(msg.parentID, state)
        : getRandomAgentName(state),
      pendingPermissions: new Map(),
      pendingAsks: new Map(),
      messageQueue: [],
      messageIDs: [],
    };

    // Clear disconnectedAt when reconnecting
    if (session.disconnectedAt) {
      delete session.disconnectedAt;
    }

    // Ensure even existing unnamed sessions get a name
    if (!session.agentName) {
      session.agentName = session.parentID
        ? getSubagentName(session.parentID, state)
        : getRandomAgentName(state);
      if (session.agentName) {
        log(`[Daemon] Assigned random name: ${session.agentName} to ${sid}`, 'info');
        // If thread exists, update it immediately
        if (session.threadID && session.chatId) {
          bot
            .editForumTopic({
              chat_id: session.chatId,
              message_thread_id: session.threadID,
              name: formatThreadTitle(session.agentName, session.project, session.title, !!session.parentID),
            })
            .catch((err) =>
              log(`[Daemon] Failed to update thread title for new random name: ${err}`, 'error')
            );
        }
      }
    }

    // Update project/title/chatId if provided (allows re-registration with new values)
    // Track whether title/project changed so we can sync the Telegram thread title
    const titleChanged = msg.title && msg.title !== session.title;
    const projectChanged = msg.project && msg.project !== session.project;
    if (msg.project) session.project = msg.project;
    if (msg.title) session.title = msg.title;
    if (msg.chatId) session.chatId = msg.chatId;
    if (!state.sessions.has(sid)) state.sessions.set(sid, session);
    saveState(state, statePath);

    // Sync Telegram thread title if project or title changed on re-register
    if ((titleChanged || projectChanged) && session.threadID && session.chatId) {
      bot
        .editForumTopic({
          chat_id: session.chatId,
          message_thread_id: session.threadID,
          name: formatThreadTitle(session.agentName, session.project, session.title, !!session.parentID),
        })
        .catch((err) =>
          log(`[Daemon] Failed to sync thread title on re-register: ${err}`, 'error')
        );
    }

    if (!session.chatId) {
      log(
        `[Daemon] WARNING: Session ${sid} registered without chatId - broadcasts and DMs will not work!`,
        'warn'
      );
    }

    log(
      `[Daemon] Registered client: ${sid} chatId: ${session.chatId} msg.chatId: ${msg.chatId}`,
      'info'
    );
    
    // Sync dashboard on registration (catches up if any meta was missed)
    if (session.threadID && session.chatId) {
      syncStatusDashboard(session, bot).catch((err) =>
        log(`[Daemon] Failed to sync dashboard on register: ${err}`, 'error')
      );
    }

    sendToClient(state.clients, sid, {
      type: 'registered',
      success: !!session.chatId,
      hasThread: !!session.threadID,
      correlationId,
    });

    if (session.threadID && session.messageQueue.length > 0) {
      for (const text of session.messageQueue) {
        sendToClient(state.clients, sid, { type: 'message', text, isThread: true });
      }
      session.messageQueue = [];
      saveState(state, statePath);
    }
    return sid;
  }
  return currentSessionID;
}

export async function handleUpdateTitle(
  msg: any,
  socket: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
) {
  const { state, statePath, bot, chatId } = ctx;
  const sessionID = msg.sessionID || currentSessionID;
  const correlationId = msg.correlationId;
  let success = false;
  if (sessionID) {
    const session = state.sessions.get(sessionID);
    if (session?.threadID && session.chatId) {
      try {
        await bot.editForumTopic({
          chat_id: session.chatId,
          message_thread_id: session.threadID,
          name: formatThreadTitle(session.agentName, session.project, msg.title, !!session.parentID),
        });
        session.title = msg.title;
        saveState(state, statePath);
        success = true;
      } catch (err) {
        log(`[Daemon] Failed to update title: ${err}`, 'error');
      }
    }
  }
  // Send ack so relay doesn't timeout
  socket.write(JSON.stringify({ type: 'update_title_ack', success, correlationId }) + '\n');
}

export async function handleSetStatus(
  msg: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
) {
  const { state, statePath } = ctx;
  const sessionID = msg.sessionID || currentSessionID;
  if (sessionID) {
    const session = state.sessions.get(sessionID);
    if (session) {
      session.status = msg.status;
      saveState(state, statePath);
    }
  }
}

export function handleUpdateMeta(
  msg: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
) {
  const { state, statePath } = ctx;
  const sessionID = msg.sessionID || currentSessionID;
  if (!sessionID) return;
  const session = state.sessions.get(sessionID);
  if (!session) return;

  let changed = false;
  if (msg.model && typeof msg.model === 'string' && msg.model !== session.model) {
    session.model = msg.model;
    changed = true;
  }
  if (msg.agentType && typeof msg.agentType === 'string' && msg.agentType !== session.agentType) {
    session.agentType = msg.agentType;
    changed = true;
  }
    if (changed) {
      saveState(state, statePath);
      log(`[Daemon] Updated meta for ${sessionID}: model=${session.model}, agentType=${session.agentType}`, 'info');
      syncStatusDashboard(session, ctx.bot).catch((err) =>
        log(`[Daemon] Failed to sync dashboard on meta update: ${err}`, 'error')
      );
    }
}


export async function handleTyping(
  msg: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
) {
  const { state, bot } = ctx;
  const sessionID = msg.sessionID || currentSessionID;
  if (sessionID) {
    const session = state.sessions.get(sessionID);
    if (session?.threadID && session.chatId) {
      try {
        await bot.sendChatAction({
          chat_id: session.chatId,
          message_thread_id: session.threadID,
          action: 'typing',
        });
      } catch (err) {
        // Typing indicator is non-critical; detect stale thread for logging but don't retry
        if (String(err).includes('message thread not found')) {
          log(`[Daemon] Typing failed due to stale thread for ${sessionID}, will recover on next send`, 'warn');
        } else {
          log(`[Daemon] Failed to send typing indicator: ${err}`, 'debug');
        }
      }
    }
  }
}

export async function handleReact(msg: any, ctx: MessageHandlerContext) {
  const { state, bot } = ctx;
  const sessionID = msg.sessionID;
  const session = state.sessions.get(sessionID);
  if (!session || !session.threadID || !session.chatId) return;

  const targetMessageID = msg.messageID || session.messageIDs[session.messageIDs.length - 1];
  if (!targetMessageID) return;

  try {
    await bot.setMessageReaction({
      chat_id: session.chatId,
      message_id: targetMessageID,
      reaction: [{ type: 'emoji', emoji: msg.emoji }],
    });
  } catch (err) {
    // Reactions are non-critical, log at debug level
    log(`[Daemon] Failed to set reaction: ${err}`, 'debug');
  }
}

export async function handleSend(
  msg: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
) {
  const { state, statePath, bot, ensureThread } = ctx;
  const sessionID = msg.sessionID || currentSessionID;
  const correlationId = msg.correlationId;
  if (!sessionID) return;
  const session = state.sessions.get(sessionID);
  if (!session || !session.chatId) {
    log(`[Daemon] handleSend: session missing or no chatId set`, 'warn', { sessionID });
    return;
  }

  if (!session.threadID) {
    await ensureThread(sessionID, session.project, session.title, session.chatId);
  }

  try {
    // Thread title already shows agent name — no prefix needed for thread messages
    const text = msg.text;
    let result = await bot.sendMessage({
      chat_id: session.chatId,
      message_thread_id: session.threadID,
      text,
      parse_mode: 'Markdown',
    });
    // Fallback to plain text if Markdown parsing fails
    if (!result.ok && result.description?.includes("can't parse entities")) {
      result = await bot.sendMessage({
        chat_id: session.chatId,
        message_thread_id: session.threadID,
        text,
      });
    }
    if (!result.ok) throw new Error(result.description);

    session.lastMessageID = result.result.message_id;
    addMessageID(session, result.result.message_id);
    saveState(state, statePath);

    sendToClient(state.clients, sessionID, {
      type: 'sent',
      success: true,
      messageID: result.result.message_id,
      correlationId,
    });
  } catch (err) {
    // Try to recover from stale thread
    const recovered = await recoverStaleThread(err, session, ctx, sessionID);
    if (recovered && session.threadID) {
      try {
        const text = msg.text;
        let result = await bot.sendMessage({
          chat_id: session.chatId,
          message_thread_id: session.threadID,
          text,
          parse_mode: 'Markdown',
        });
        if (!result.ok && result.description?.includes("can't parse entities")) {
          result = await bot.sendMessage({
            chat_id: session.chatId,
            message_thread_id: session.threadID,
            text,
          });
        }
        if (!result.ok) throw new Error(result.description);
        session.lastMessageID = result.result.message_id;
        addMessageID(session, result.result.message_id);
        saveState(state, statePath);
        sendToClient(state.clients, sessionID, {
          type: 'sent',
          success: true,
          messageID: result.result.message_id,
          correlationId,
        });
        return;
      } catch (retryErr) {
        log(`[Daemon] Failed to send after thread recovery: ${retryErr}`, 'error');
      }
    }
    log(`[Daemon] Failed to send: ${err}`, 'error');
    sendToClient(state.clients, sessionID, {
      type: 'sent',
      success: false,
      error: String(err),
      correlationId,
    });
  }
}

export async function handleBroadcast(
  msg: any,
  socket: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
) {
  const { state, bot } = ctx;
  const correlationId = msg.correlationId;

  // Session must exist and have a chatId to broadcast
  if (!currentSessionID) {
    socket.write(
      JSON.stringify({ type: 'broadcast', success: false, error: 'No session', correlationId }) +
        '\n'
    );
    return;
  }

  const session = state.sessions.get(currentSessionID);
  if (!session?.chatId) {
    socket.write(
      JSON.stringify({
        type: 'broadcast',
        success: false,
        error: 'No chatId configured for session',
        correlationId,
      }) + '\n'
    );
    return;
  }

  try {
    const namePart = session.agentName ? `**[${session.agentName}]:** ` : '';
    let text = `${namePart}${msg.text}`;

    let result = await bot.sendMessage({ chat_id: session.chatId, text, parse_mode: 'Markdown' });
    // Fallback to plain text if Markdown parsing fails
    if (!result.ok && result.description?.includes("can't parse entities")) {
      result = await bot.sendMessage({ chat_id: session.chatId, text });
    }
    if (!result.ok) throw new Error(result.description);
    socket.write(
      JSON.stringify({
        type: 'broadcast',
        success: true,
        messageID: result.result.message_id,
        correlationId,
      }) + '\n'
    );
  } catch (err) {
    socket.write(
      JSON.stringify({ type: 'broadcast', success: false, error: String(err), correlationId }) +
        '\n'
    );
  }
}

export async function handleReplyTo(
  msg: any,
  socket: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
) {
  const { state, statePath, bot, ensureThread } = ctx;
  const sessionID = msg.sessionID || currentSessionID;
  const correlationId = msg.correlationId;
  const session = state.sessions.get(sessionID);
  if (!session || !session.chatId) return;

  if (!session.threadID) {
    await ensureThread(sessionID, session.project, session.title, session.chatId);
  }

  try {
    let res = await bot.sendMessage({
      chat_id: session.chatId,
      message_thread_id: session.threadID,
      text: msg.text,
      reply_to_message_id: msg.messageID,
      parse_mode: 'Markdown',
    });
    // Fallback to plain text if Markdown parsing fails
    if (!res.ok && res.description?.includes("can't parse entities")) {
      res = await bot.sendMessage({
        chat_id: session.chatId,
        message_thread_id: session.threadID,
        text: msg.text,
        reply_to_message_id: msg.messageID,
      });
    }
    if (!res.ok) throw new Error(res.description);
    addMessageID(session, res.result.message_id);
    saveState(state, statePath);
    socket.write(
      JSON.stringify({
        type: 'reply_to',
        success: true,
        messageID: res.result.message_id,
        correlationId,
      }) + '\n'
    );
  } catch (err) {
    const recovered = await recoverStaleThread(err, session, ctx, sessionID);
    if (recovered && session.threadID) {
      try {
        // Retry without reply_to_message_id since old message won't exist in new thread
        let res = await bot.sendMessage({
          chat_id: session.chatId,
          message_thread_id: session.threadID,
          text: msg.text,
          parse_mode: 'Markdown',
        });
        if (!res.ok && res.description?.includes("can't parse entities")) {
          res = await bot.sendMessage({
            chat_id: session.chatId,
            message_thread_id: session.threadID,
            text: msg.text,
          });
        }
        if (!res.ok) throw new Error(res.description);
        addMessageID(session, res.result.message_id);
        saveState(state, statePath);
        socket.write(
          JSON.stringify({
            type: 'reply_to',
            success: true,
            messageID: res.result.message_id,
            correlationId,
          }) + '\n'
        );
        return;
      } catch (retryErr) {
        log(`[Daemon] Failed to reply after thread recovery: ${retryErr}`, 'error');
      }
    }
    socket.write(
      JSON.stringify({ type: 'reply_to', success: false, error: String(err), correlationId }) + '\n'
    );
  }
}

export async function handleAsk(
  msg: any,
  socket: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
) {
  const { state, statePath, bot, ensureThread } = ctx;
  const sessionID = msg.sessionID || currentSessionID;
  const correlationId = msg.correlationId;
  const session = state.sessions.get(sessionID);
  if (!session || !session.chatId) return;

  if (!session.threadID) {
    await ensureThread(sessionID, session.project, session.title, session.chatId);
  }

  const askID = msg.askID;
  const options = [...(msg.options as string[])];
  if (!options.includes('None of the above')) {
    options.push('None of the above');
  }
  if (!session.pendingAsks) session.pendingAsks = new Map();
  session.pendingAsks.set(askID, options);

  const inline_keyboard = [];
  for (let i = 0; i < options.length; i += 2) {
    inline_keyboard.push(
      options.slice(i, i + 2).map((opt) => ({
        text: opt,
        callback_data: `ask:${askID}:${opt}`,
      }))
    );
  }

  try {
    const res = await bot.sendMessage({
      chat_id: session.chatId,
      message_thread_id: session.threadID,
      text: msg.question,
      reply_markup: { inline_keyboard },
    });
    addMessageID(session, res.result.message_id);
    saveState(state, statePath);
    socket.write(JSON.stringify({ type: 'ask_ack', askID, success: true, correlationId }) + '\n');
  } catch (err) {
    const recovered = await recoverStaleThread(err, session, ctx, sessionID);
    if (recovered && session.threadID) {
      try {
        const res = await bot.sendMessage({
          chat_id: session.chatId,
          message_thread_id: session.threadID,
          text: msg.question,
          reply_markup: { inline_keyboard },
        });
        addMessageID(session, res.result.message_id);
        saveState(state, statePath);
        socket.write(JSON.stringify({ type: 'ask_ack', askID, success: true, correlationId }) + '\n');
        return;
      } catch (retryErr) {
        log(`[Daemon] Failed to send ask after thread recovery: ${retryErr}`, 'error');
      }
    }
    socket.write(
      JSON.stringify({
        type: 'ask_ack',
        askID,
        success: false,
        error: String(err),
        correlationId,
      }) + '\n'
    );
  }
}

export async function handleDeleteSession(msg: any, socket: any, ctx: MessageHandlerContext) {
  const { state, statePath, bot } = ctx;
  const sid = msg.sessionID;
  const correlationId = msg.correlationId;
  const session = state.sessions.get(sid);
  if (!session) return;

  if (session.threadID && session.chatId) {
    try {
      await bot.deleteForumTopic({ chat_id: session.chatId, message_thread_id: session.threadID });
    } catch (err) {
      // Thread deletion is non-critical during session cleanup
      log(`[Daemon] Failed to delete thread during session deletion: ${err}`, 'warn');
    }
    state.threadToSession.delete(`${session.chatId}:${session.threadID}`);
    state.threadToSession.delete(String(session.threadID));
  }
  state.sessions.delete(sid);
  state.clients.delete(sid);
  saveState(state, statePath);
  socket.write(JSON.stringify({ type: 'session_deleted', success: true, correlationId }) + '\n');
}

export async function handleDeregister(
  msg: any,
  socket: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
) {
  const { state, statePath } = ctx;
  const sessionID = msg.sessionID || currentSessionID;
  const correlationId = msg.correlationId;

  if (sessionID) {
    // Mark session as disconnected but don't delete
    const session = state.sessions.get(sessionID);
    if (session) {
      session.status = 'disconnected';
      session.disconnectedAt = Date.now();
      saveState(state, statePath);
    }
    state.clients.delete(sessionID);
  }

  socket.write(JSON.stringify({ type: 'deregistered', success: true, correlationId }) + '\n');
}

export async function handleSetAgentName(
  msg: any,
  socket: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
) {
  const { state, statePath, bot } = ctx;
  const sessionID = msg.sessionID || currentSessionID;
  const correlationId = msg.correlationId;
  if (sessionID) {
    const session = state.sessions.get(sessionID);
    if (session) {
      // Validate name exists and is not empty
      if (!msg.name || typeof msg.name !== 'string') {
        if (socket) {
          socket.write(
            JSON.stringify({
              type: 'agent_name_set',
              success: false,
              error: 'Name is required and must be a string.',
              correlationId,
            }) + '\n'
          );
        }
        return;
      }

      const newName = msg.name.trim();

      if (newName === '') {
        if (socket) {
          socket.write(
            JSON.stringify({
              type: 'agent_name_set',
              success: false,
              error: 'Name cannot be empty or whitespace only.',
              correlationId,
            }) + '\n'
          );
        }
        return;
      }

      // Check for name collision
      const isNameTaken = Array.from(state.sessions.values()).some(
        (s) => s.sessionID !== sessionID && s.agentName?.toLowerCase() === newName.toLowerCase()
      );

      if (isNameTaken) {
        if (socket) {
          socket.write(
            JSON.stringify({
              type: 'agent_name_set',
              success: false,
              error: `Name "${newName}" is already in use by another session. Please pick a different creative name.`,
              correlationId,
            }) + '\n'
          );
        }
        return;
      }

      session.agentName = newName;
      saveState(state, statePath);
      // Update thread title and dashboard with new agent name
      if (session.threadID && session.chatId) {
        syncStatusDashboard(session, bot).catch((err) =>
          log(`[Daemon] Failed to sync dashboard on agent name change: ${err}`, 'error')
        );
        try {
          await bot.editForumTopic({
            chat_id: session.chatId,
            message_thread_id: session.threadID,
            name: formatThreadTitle(newName, session.project, session.title, !!session.parentID),
          });
        } catch (err) {
          log(`[Daemon] Failed to update thread title: ${err}`, 'error');
        }
      }
      if (socket) {
        socket.write(
          JSON.stringify({ type: 'agent_name_set', success: true, correlationId }) + '\n'
        );
      }
    }
  }
}

export async function handlePermissionRequest(
  msg: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
) {
  const { state, statePath, bot, ensureThread } = ctx;
  const sid = currentSessionID || msg.sessionID;
  if (!sid) return;
  const session = state.sessions.get(sid);
  if (!session || !session.chatId) return;

  if (!session.threadID) await ensureThread(sid, session.project, session.title, session.chatId);

  try {
    const result = await bot.sendMessage({
      chat_id: session.chatId,
      message_thread_id: session.threadID,
      text: `🔒 **Permission Request**\n\n**Tool:** \`${msg.tool}\`\n**Description:** ${msg.description}`,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve:${msg.permissionID}` },
            { text: '❌ Deny', callback_data: `deny:${msg.permissionID}` },
          ],
          [
            { text: '🛡️ Always', callback_data: `always:${msg.permissionID}` },
            { text: '🚫 Never', callback_data: `never:${msg.permissionID}` },
          ],
        ],
      },
    });
    session.pendingPermissions.set(msg.permissionID, result.result.message_id);
    saveState(state, statePath);
  } catch (err) {
    const recovered = await recoverStaleThread(err, session, ctx, sid);
    if (recovered && session.threadID) {
      try {
        const result = await bot.sendMessage({
          chat_id: session.chatId,
          message_thread_id: session.threadID,
          text: `🔒 **Permission Request**\n\n**Tool:** \`${msg.tool}\`\n**Description:** ${msg.description}`,
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Approve', callback_data: `approve:${msg.permissionID}` },
                { text: '❌ Deny', callback_data: `deny:${msg.permissionID}` },
              ],
              [
                { text: '🛡️ Always', callback_data: `always:${msg.permissionID}` },
                { text: '🚫 Never', callback_data: `never:${msg.permissionID}` },
              ],
            ],
          },
        });
        session.pendingPermissions.set(msg.permissionID, result.result.message_id);
        saveState(state, statePath);
        return;
      } catch (retryErr) {
        log(`[Daemon] Failed to send permission request after thread recovery: ${retryErr}`, 'error');
      }
    }
    log(`[Daemon] Failed to send permission request: ${err}`, 'debug');
  }
}

export async function handleErrorNotification(
  msg: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
) {
  const { state, bot } = ctx;
  const sid = currentSessionID || msg.sessionID;
  if (!sid) return;
  const session = state.sessions.get(sid);
  if (!session || !session.chatId) return;

  if (session?.threadID) {
    try {
      await bot.sendMessage({
        chat_id: session.chatId,
        message_thread_id: session.threadID,
        text: `⚠️ Error: ${msg.errorName}\n${msg.errorMessage}`,
      });
    } catch (err) {
      const recovered = await recoverStaleThread(err, session, ctx, sid);
      if (recovered && session.threadID) {
        try {
          await bot.sendMessage({
            chat_id: session.chatId,
            message_thread_id: session.threadID,
            text: `⚠️ Error: ${msg.errorName}\n${msg.errorMessage}`,
          });
          return;
        } catch (retryErr) {
          log(`[Daemon] Failed to send error notification after thread recovery: ${retryErr}`, 'error');
        }
      }
      // Error notifications are non-critical, log at debug level
      log(`[Daemon] Failed to send error notification: ${err}`, 'debug');
    }
  }
}

export async function handleSetChat(
  msg: any,
  socket: any,
  ctx: MessageHandlerContext,
  currentSessionID: string | null
) {
  const { state, statePath, ensureThread } = ctx;
  const sessionID = msg.sessionID || currentSessionID;
  const correlationId = msg.correlationId;
  const newChatId = msg.chatId;

  if (!sessionID) {
    socket.write(
      JSON.stringify({ type: 'set_chat_ack', success: false, error: 'No session', correlationId }) + '\n'
    );
    return;
  }

  if (!newChatId || typeof newChatId !== 'string') {
    socket.write(
      JSON.stringify({ type: 'set_chat_ack', success: false, error: 'chatId is required', correlationId }) + '\n'
    );
    return;
  }

  const session = state.sessions.get(sessionID);
  if (!session) {
    socket.write(
      JSON.stringify({ type: 'set_chat_ack', success: false, error: 'Session not found', correlationId }) + '\n'
    );
    return;
  }

  // Clear old thread mapping if thread existed in old chat
  if (session.threadID && session.chatId) {
    state.threadToSession.delete(`${session.chatId}:${session.threadID}`);
    state.threadToSession.delete(String(session.threadID));
  }

  // Update session chatId and clear threadID so a new one is created
  const oldChatId = session.chatId;
  session.chatId = newChatId;
  session.threadID = undefined;
  saveState(state, statePath);

  log(`[Daemon] Switching session ${sessionID} from chat ${oldChatId} to ${newChatId}`, 'info');

  // Create a new thread in the target chat
  try {
    const threadID = await ensureThread(sessionID, session.project, session.title, newChatId);
    socket.write(
      JSON.stringify({
        type: 'set_chat_ack',
        success: true,
        threadID,
        correlationId,
      }) + '\n'
    );
  } catch (err) {
    log(`[Daemon] Failed to create thread in new chat: ${err}`, 'error');
    socket.write(
      JSON.stringify({
        type: 'set_chat_ack',
        success: false,
        error: `Failed to create thread in new chat: ${String(err)}`,
        correlationId,
      }) + '\n'
    );
  }
}

export function handleHealth(msg: any, socket: any, ctx: MessageHandlerContext, startTime: number) {
  const { state } = ctx;
  const correlationId = msg.correlationId;

  const uptimeMs = Date.now() - startTime;
  const uptimeSec = Math.floor(uptimeMs / MS_PER_SECOND);
  const uptimeMin = Math.floor(uptimeSec / SECONDS_PER_MINUTE);
  const uptimeHours = Math.floor(uptimeMin / SECONDS_PER_MINUTE);

  // Format uptime
  let uptimeStr: string;
  if (uptimeHours > 0) {
    uptimeStr = `${uptimeHours}h ${uptimeMin % SECONDS_PER_MINUTE}m`;
  } else if (uptimeMin > 0) {
    uptimeStr = `${uptimeMin}m ${uptimeSec % SECONDS_PER_MINUTE}s`;
  } else {
    uptimeStr = `${uptimeSec}s`;
  }

  // Count sessions by status
  const sessions = Array.from(state.sessions.values());
  const connectedCount = Array.from(state.clients.keys()).length;
  const totalSessions = sessions.length;
  const idleSessions = sessions.filter((s) => s.status === 'idle').length;
  const busySessions = sessions.filter((s) => s.status === 'busy').length;
  const disconnectedSessions = sessions.filter((s) => s.status === 'disconnected').length;

  const health = {
    type: 'health_response',
    correlationId,
    pid: process.pid,
    uptime: uptimeStr,
    uptimeMs,
    telegram: {
      connected: true, // If we got here, bot is working
      botUsername: 'unknown',
    },
    sessions: {
      total: totalSessions,
      connected: connectedCount,
      idle: idleSessions,
      busy: busySessions,
      disconnected: disconnectedSessions,
    },
    threads: state.threadToSession.size,
    memory: {
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / BYTES_PER_KB / KB_PER_MB),
      rssMB: Math.round(process.memoryUsage().rss / BYTES_PER_KB / KB_PER_MB),
    },
  };

  socket.write(JSON.stringify(health) + '\n');
}

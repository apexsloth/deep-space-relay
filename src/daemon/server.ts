import { createServer } from 'node:net';
import type { TelegramClient } from '../telegram';
import { saveState, type DaemonState } from './state';
import {
  handleRegister,
  handleDeregister,
  handleUpdateTitle,
  handleSetStatus,
  handleTyping,
  handleReact,
  handleSend,
  handleBroadcast,
  handleReplyTo,
  handleAsk,
  handleDeleteSession,
  handleSetAgentName,
  handlePermissionRequest,
  handleErrorNotification,
  handleHealth,
  handleUpdateMeta,
  handleSetChat,
  type MessageHandlerContext,
} from './handlers';
import { MAX_BUFFER_SIZE, AUTH_CHECK_INTERVAL_MS } from '../constants';

// Track daemon start time for uptime calculation
const daemonStartTime = Date.now();
import { log } from './logger';

export function createSocketServer(
  socketPath: string,
  state: DaemonState,
  statePath: string,
  bot: TelegramClient,
  getChatId: () => string,
  reconcile: (sessionID: string) => Promise<number | undefined>,
  ipcToken?: string
) {
  // SECURITY: Require non-empty token for authentication
  if (!ipcToken || ipcToken.trim() === '') {
    const error = 'SECURITY: Cannot start daemon with empty or missing authentication token';
    log(error, 'error');
    throw new Error(error);
  }

  const server = createServer((socket) => {
    let currentSessionID: string | null = null;
    let authenticated = false; // Always require authentication when token is provided
    let buffer = '';
    log('[Daemon] New client connected', 'debug');

    socket.on('data', async (data) => {
      buffer += data.toString();

      if (buffer.length > MAX_BUFFER_SIZE) {
        log('[Daemon] Buffer size limit exceeded, disconnecting client', 'warn', {
          bufferSize: buffer.length,
          limit: MAX_BUFFER_SIZE,
        });
        socket.destroy();
        return;
      }

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const msg = JSON.parse(line);

          // Skip logging for high-frequency or internal commands
          const isHighFreq = msg.type === 'set_status' || msg.type === 'update_meta' || msg.type === 'ping' || msg.type === 'auth';
          
          if (!isHighFreq) {
            log('[Daemon] Socket data received', 'debug', { size: line.length, type: msg.type });
          }

          if (!authenticated) {
            // Allow ping to bypass auth for leader health checks.
            // The stale-socket detector (lifecycle.ts) may connect with a
            // different IPC token; it only needs a pong to know the daemon
            // is alive.  No sensitive data, no state mutation.
            if (msg.type === 'ping') {
              socket.write(JSON.stringify({ type: 'pong', pid: process.pid }) + '\n');
              continue;
            }

            const authSuccess = msg.token === ipcToken;
            log('[Daemon] Auth attempt: ' + msg.type + ' success: ' + authSuccess, 'debug');
            if (msg.type === 'auth' && authSuccess) {
              authenticated = true;
              socket.write(JSON.stringify({ type: 'auth_ack', success: true }) + '\n');
              continue;
            } else {
              log('[Daemon] Client failed authentication or sent command before auth', 'warn');
              socket.write(
                JSON.stringify({
                  type: 'auth_ack',
                  success: false,
                  error: 'Authentication required',
                }) + '\n'
              );
              socket.destroy();
              return;
            }
          }

          const chatId = getChatId();
          // Skip logging for high-frequency or internal commands
          if (msg.type !== 'set_status' && msg.type !== 'update_meta' && msg.type !== 'ping' && msg.type !== 'auth') {
            const sessionRef = msg.sessionID || currentSessionID;
            log(
              `[Daemon] Received command: ${msg.type}${sessionRef ? ` for ${sessionRef}` : ''}`,
              'debug'
            );
          }

          const ctx: MessageHandlerContext = {
            state,
            statePath,
            bot,
            chatId,
            reconcile: (sessionID: string) => reconcile(sessionID),
          };

          switch (msg.type) {
            case 'ping':
              // Heartbeat response for leader election - write directly to socket
              socket.write(JSON.stringify({ type: 'pong', pid: process.pid }) + '\n');
              break;

            case 'shutdown': {
              // Handle force takeover shutdown request
              const reason = msg.reason || 'unknown';
              log(`[Daemon] Received shutdown request, reason: ${reason}`, 'info');
              socket.write(JSON.stringify({ type: 'shutdown_ack', reason }) + '\n');

              // Give time for acknowledgment to be sent
              setTimeout(() => {
                log('[Daemon] Shutting down gracefully for leadership takeover', 'info');
                process.exit(0);
              }, AUTH_CHECK_INTERVAL_MS);
              break;
            }

            case 'get_config':
              // Return daemon config (chatId, etc.)
              socket.write(
                JSON.stringify({
                  type: 'config',
                  chatId: chatId || null,
                  correlationId: msg.correlationId,
                }) + '\n'
              );
              break;

            case 'register': {
              const newSessionID = await handleRegister(msg, socket, ctx, currentSessionID);
              if (newSessionID) currentSessionID = newSessionID;
              break;
            }

            case 'deregister':
              await handleDeregister(msg, socket, ctx, currentSessionID);
              currentSessionID = null;
              break;

            case 'update_title':
              await handleUpdateTitle(msg, socket, ctx, currentSessionID);
              break;

            case 'set_status':
              await handleSetStatus(msg, ctx, currentSessionID);
              break;

            case 'typing':
              await handleTyping(msg, ctx, currentSessionID);
              break;

            case 'react':
              await handleReact(msg, ctx);
              break;

            case 'send':
              await handleSend(msg, ctx, currentSessionID);
              break;

            case 'broadcast':
              await handleBroadcast(msg, socket, ctx, currentSessionID);
              break;

            case 'reply_to':
              await handleReplyTo(msg, socket, ctx, currentSessionID);
              break;

            case 'ask':
              await handleAsk(msg, socket, ctx, currentSessionID);
              break;

            case 'delete_session':
              await handleDeleteSession(msg, socket, ctx);
              break;

            case 'set_agent_name':
              await handleSetAgentName(msg, socket, ctx, currentSessionID);
              break;

            case 'update_meta':
              handleUpdateMeta(msg, ctx, currentSessionID);
              break;

            case 'permission':
            case 'permission_request':
              await handlePermissionRequest(msg, ctx, currentSessionID);
              break;

            case 'error_notification':
              await handleErrorNotification(msg, ctx, currentSessionID);
              break;

            case 'health':
              handleHealth(msg, socket, ctx, daemonStartTime);
              break;

            case 'set_chat':
              await handleSetChat(msg, socket, ctx, currentSessionID);
              break;

            default:
              log(`[Daemon] Unknown message type: ${msg.type}`, 'warn');
          }
        } catch (err) {
          log(`[Daemon] Failed to parse socket message: ${err}`, 'error', { line });
        }
      }
    });

    socket.on('close', () => {
      if (currentSessionID) {
        state.clients.delete(currentSessionID);
        const session = state.sessions.get(currentSessionID);
        if (session) {
          session.status = 'disconnected';
          session.disconnectedAt = Date.now();
          saveState(state, statePath);
        }
      }
    });
  });

  return server;
}

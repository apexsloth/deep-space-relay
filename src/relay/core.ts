import { connect, Socket } from 'net';
import { randomBytes } from 'node:crypto';
import { loadConfig, getSocketPath } from '../config';
import type { RelayConfig, RelayState } from '../types';
import {
  IPC_REQUEST_TIMEOUT_MS,
  MAX_BUFFER_SIZE,
  PERMISSION_REQUEST_TIMEOUT_MS,
  ASK_REQUEST_TIMEOUT_MS,
  CONFIG_FETCH_TIMEOUT_MS,
} from '../constants';

// Counter for generating unique correlation IDs within this process
let correlationCounter = 0;
function generateCorrelationId(): string {
  const entropy = randomBytes(4).toString('hex');
  return `${process.pid}_${Date.now()}_${++correlationCounter}_${entropy}`;
}

export function createRelay(config: RelayConfig) {
  const {
    project,
    directory,
    chatId: configChatId,
    log,
    onMessage,
    onPermissionResponse,
    onStop,
    socketPath: configSocketPath,
    ipcToken: initialIpcToken,
  } = config;

  let ipcToken = initialIpcToken;

  const pendingAskResolvers = new Map<string, (selection: string) => void>();

  // Use config socket path, then environment variable, then secure default
  const socketPath = configSocketPath || getSocketPath();

  // State - NO threadID, daemon handles all mapping
  let socket: Socket | null = null;
  let registered = false;
  let hasThread = false;
  let sessionID: string | null = null;
  let lastMessageID: number | undefined;
  let currentTitle: string | undefined;
  let chatId: string | null = configChatId || null;
  const pendingResolves = new Map<string, (value: any) => void>();
  const pendingPermissionResolvers = new Map<string, (response: string) => void>();
  let buffer = '';

  // Lock to prevent multiple concurrent connection attempts
  let connectionPromise: Promise<Socket> | null = null;

  const ensureSocket = (): Promise<Socket> => {
    if (socket?.writable) {
      return Promise.resolve(socket);
    }

    if (connectionPromise) {
      return connectionPromise;
    }

    connectionPromise = new Promise((resolve, reject) => {
      const cleanup = () => {
        connectionPromise = null;
      };

      const newSocket = connect(socketPath);
      // Unref socket so it doesn't keep the process alive on Ctrl+C
      newSocket.unref();

      newSocket.on('connect', () => {
        // Use bot token for IPC auth - already shared between daemon and clients
        // Only load from config if we don't already have a token
        if (!ipcToken) {
          const dsrConfig = loadConfig(directory);
          ipcToken = dsrConfig.token || '';
        }
        if (ipcToken) {
          newSocket.write(JSON.stringify({ type: 'auth', token: ipcToken }) + '\n');
        }
        log('Connected to relay daemon', 'info');
        socket = newSocket;
        cleanup();
        resolve(newSocket);
      });

      newSocket.on('error', (err) => {
        log('Socket error', 'warn', { error: String(err) });
        cleanup();
        reject(err);
      });

      newSocket.on('data', (data) => {
        buffer += data.toString();

        // SECURITY: Check buffer size limit to prevent memory exhaustion
        if (buffer.length > MAX_BUFFER_SIZE) {
          log('Buffer size limit exceeded, disconnecting from daemon', 'warn', {
            bufferSize: buffer.length,
            limit: MAX_BUFFER_SIZE,
          });
          newSocket.destroy();
          return;
        }

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);

            // First, try to resolve by correlationId (new approach)
            if (msg.correlationId && pendingResolves.has(msg.correlationId)) {
              // Update state based on message type before resolving
              if (msg.type === 'registered') {
                registered = true;
                hasThread = !!msg.hasThread;
              } else if (msg.type === 'deregistered') {
                registered = false;
                hasThread = false;
                sessionID = null;
              } else if (msg.type === 'sent' || msg.type === 'reply_to') {
                if (msg.messageID) lastMessageID = msg.messageID;
                if (msg.success && msg.messageID) hasThread = true;
              } else if (msg.type === 'broadcast') {
                if (msg.messageID) lastMessageID = msg.messageID;
              } else if (msg.type === 'config') {
                chatId = msg.chatId || null;
              }

              const resolver = pendingResolves.get(msg.correlationId);
              pendingResolves.delete(msg.correlationId);
              resolver?.(msg);
              continue;
            }

            // Handle thread creation notification (no correlationId expected)
            if (msg.type === 'thread_created') {
              hasThread = true;
            }

            // Handle incoming messages from Telegram
            if (msg.type === 'message' && msg.text && onMessage) {
              if (msg.messageID) lastMessageID = msg.messageID;
              // If we receive a thread message, the thread exists - update state
              if (msg.isThread) hasThread = true;
              onMessage(msg.text, msg.isThread ?? false, msg.messageID);
            }

            // Handle permission responses from Telegram buttons
            if (msg.type === 'permission_response') {
              const permissionID = msg.permissionID;
              const action = msg.action;

              // Resolve pending askPermission call if exists
              if (permissionID && pendingPermissionResolvers.has(permissionID)) {
                const resolver = pendingPermissionResolvers.get(permissionID);
                pendingPermissionResolvers.delete(permissionID);
                resolver?.(action);
              }

              // Also call legacy callback if exists
              if (onPermissionResponse) {
                onPermissionResponse(permissionID, action);
              }
            }

            // Handle selection responses from Telegram buttons (dsr_ask)
            if (msg.type === 'ask_response') {
              const askID = msg.askID;
              const selection = msg.selection;

              if (askID && pendingAskResolvers.has(askID)) {
                const resolver = pendingAskResolvers.get(askID);
                pendingAskResolvers.delete(askID);
                resolver?.(selection);
              }
            }

            // Handle stop command from Telegram
            if (msg.type === 'stop' && onStop) {
              onStop();
            }
          } catch {
            // Expected: Partial JSON lines during streaming, continue waiting for complete message
          }
        }
      });

      newSocket.on('close', () => {
        if (socket === newSocket) {
          socket = null;
          registered = false;
        }
        cleanup();
      });
    });

    return connectionPromise;
  };

  const sendToSocket = (msg: object) => {
    ensureSocket()
      .then((sock) => {
        // Always include sessionID if we have it
        const finalMsg = sessionID ? { ...msg, sessionID } : msg;
        sock.write(JSON.stringify(finalMsg) + '\n');
      })
      .catch((err) => {
        log('Failed to send to socket', 'warn', { error: String(err) });
      });
  };

  const sendAndWait = async (
    msg: object,
    responseType: string,
    debugLocation: string,
    signal?: AbortSignal | null
  ): Promise<any> => {
    if (signal?.aborted) {
      throw signal.reason || new Error('Aborted');
    }

    const correlationId = generateCorrelationId();
    const sock = await ensureSocket();
    return new Promise((resolve, reject) => {
      let timeout: any;

      const onAbort = () => {
        if (timeout) clearTimeout(timeout);
        pendingResolves.delete(correlationId);
        reject(signal?.reason || new Error('Aborted'));
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      pendingResolves.set(correlationId, (response) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (timeout) clearTimeout(timeout);
        resolve(response);
      });

      const msgWithDebug = { ...msg, _debug: debugLocation, correlationId };
      sock.write(JSON.stringify(msgWithDebug) + '\n');

      timeout = setTimeout(() => {
        if (pendingResolves.has(correlationId)) {
          pendingResolves.delete(correlationId);
          if (signal) signal.removeEventListener('abort', onAbort);
          reject(new Error(`Timeout waiting for response (${responseType})`));
        }
      }, IPC_REQUEST_TIMEOUT_MS);
      timeout.unref();
    });
  };

  // Public API
  return {
    // Register session with daemon (idempotent - updates title if changed)
    async register(
      sid: string,
      title: string,
      signal?: AbortSignal | null
    ): Promise<{ success: boolean; error?: string }> {
      try {
        sessionID = sid;
        currentTitle = title;
        await sendAndWait(
          { type: 'register', sessionID: sid, project, title, chatId },
          'register',
          'relay/core.ts:register',
          signal
        );
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Deregister session
    async deregister(signal?: AbortSignal | null): Promise<{ success: boolean; error?: string }> {
      if (!registered || !sessionID) {
        return { success: false, error: 'Not registered.' };
      }
      try {
        await sendAndWait(
          { type: 'deregister', sessionID },
          'deregister',
          'relay/core.ts:deregister',
          signal
        );
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Send DM to this session's thread
    async send(
      text: string,
      signal?: AbortSignal | null
    ): Promise<{ success: boolean; error?: string }> {
      if (!registered) {
        return { success: false, error: 'Not registered. Call register() first.' };
      }
      try {
        const response = await sendAndWait(
          { type: 'send', text },
          'send',
          'relay/core.ts:send',
          signal
        );
        return { success: response.success, error: response.error };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Broadcast to main channel (not a thread)
    async broadcast(
      text: string,
      signal?: AbortSignal | null
    ): Promise<{ success: boolean; error?: string }> {
      try {
        const response = await sendAndWait(
          { type: 'broadcast', text },
          'broadcast',
          'relay/core.ts:broadcast',
          signal
        );
        return { success: response.success, error: response.error };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Reply to a specific message by ID
    async replyTo(
      messageID: number,
      text: string,
      signal?: AbortSignal | null
    ): Promise<{ success: boolean; error?: string }> {
      if (!registered) {
        return { success: false, error: 'Not registered. Call register() first.' };
      }
      try {
        const response = await sendAndWait(
          { type: 'reply_to', messageID, text },
          'reply_to',
          'relay/core.ts:replyTo',
          signal
        );
        return { success: response.success, error: response.error };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Send permission request to Telegram with approve/deny buttons
    async sendPermission(
      permissionID: string,
      tool: string,
      description?: string,
      signal?: AbortSignal | null
    ): Promise<{ success: boolean; error?: string }> {
      if (!registered) {
        return { success: false, error: 'Not registered. Call register() first.' };
      }
      try {
        const response = await sendAndWait(
          { type: 'permission', permissionID, tool, description },
          'permission',
          'relay/core.ts:sendPermission',
          signal
        );
        return { success: response.success, error: response.error };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Ask permission via Telegram and WAIT for user response
    async askPermission(
      permissionID: string,
      tool: string,
      description?: string,
      signal?: AbortSignal | null
    ): Promise<{ success: boolean; response?: string; error?: string }> {
      if (!registered) {
        return { success: false, error: 'Not registered. Call register() first.' };
      }

      if (signal?.aborted) {
        return { success: false, error: signal.reason?.message || 'Aborted' };
      }

      return new Promise((resolve) => {
        let timeout: any;

        const onAbort = () => {
          if (timeout) clearTimeout(timeout);
          pendingPermissionResolvers.delete(permissionID);
          resolve({ success: false, error: signal?.reason?.message || 'Aborted' });
        };

        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }

        // Store resolver to be called when permission_response arrives
        pendingPermissionResolvers.set(permissionID, (response: string) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          if (timeout) clearTimeout(timeout);
          resolve({ success: true, response });
        });

        // Send the permission request
        sendToSocket({ type: 'permission', permissionID, tool, description });

        // Timeout after 5 minutes
        timeout = setTimeout(() => {
          if (pendingPermissionResolvers.has(permissionID)) {
            pendingPermissionResolvers.delete(permissionID);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve({ success: false, error: 'Permission request timed out' });
          }
        }, PERMISSION_REQUEST_TIMEOUT_MS);
        timeout.unref();
      });
    },

    // Set status (updates thread title emoji)
    async setStatus(status: 'idle' | 'busy'): Promise<{ success: boolean; error?: string }> {
      if (!registered) {
        return { success: false, error: 'Not registered. Call register() first.' };
      }
      try {
        // Fire and forget for speed - don't wait
        sendToSocket({ type: 'set_status', status });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Delete a session and its thread (for cleanup/testing)
    async deleteSession(
      sid: string,
      signal?: AbortSignal | null
    ): Promise<{ success: boolean; error?: string }> {
      try {
        const response = await sendAndWait(
          { type: 'delete_session', sessionID: sid },
          'delete_session',
          'relay/core.ts:deleteSession',
          signal
        );
        return { success: response.success, error: response.error };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Update thread title (when session is renamed)
    async updateTitle(
      title: string,
      signal?: AbortSignal | null
    ): Promise<{ success: boolean; error?: string }> {
      if (!registered) {
        return { success: false, error: 'Not registered. Call register() first.' };
      }
      try {
        const response = await sendAndWait(
          { type: 'update_title', title },
          'update_title',
          'relay/core.ts:updateTitle',
          signal
        );
        if (response.success) {
          currentTitle = title;
        }
        return { success: response.success, error: response.error };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Send typing indicator to Telegram
    async sendTyping(): Promise<{ success: boolean; error?: string }> {
      if (!registered) {
        return { success: false, error: 'Not registered. Call register() first.' };
      }
      try {
        // Fire and forget - don't wait for ack
        sendToSocket({ type: 'typing' });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Send error notification to Telegram
    async sendError(
      errorName: string,
      errorMessage: string
    ): Promise<{ success: boolean; error?: string }> {
      if (!registered) {
        return { success: false, error: 'Not registered. Call register() first.' };
      }
      try {
        // Fire and forget
        sendToSocket({ type: 'error_notification', errorName, errorMessage });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Set agent name (e.g. "Kawaii Sloth") and optionally update session title
    async setAgentName(
      name: string,
      sessionTitle?: string,
      signal?: AbortSignal | null
    ): Promise<{ success: boolean; error?: string }> {
      if (!registered) {
        return { success: false, error: 'Not registered. Call register() first.' };
      }
      try {
        const response = await sendAndWait(
          { type: 'set_agent_name', name, sessionTitle },
          'set_agent_name',
          'relay/core.ts:setAgentName',
          signal
        );
        return { success: response.success, error: response.error };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // React to a message with an emoji (defaults to last message)
    async react(emoji: string): Promise<{ success: boolean; error?: string }> {
      if (!registered) {
        return { success: false, error: 'Not registered. Call register() first.' };
      }
      try {
        sendToSocket({ type: 'react', emoji });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // React to a specific message by ID (optional messageID defaults to last message)
    async reactTo(
      emoji: string,
      messageID?: number
    ): Promise<{ success: boolean; error?: string }> {
      if (!registered) {
        return { success: false, error: 'Not registered. Call register() first.' };
      }
      try {
        // If no messageID provided, use lastMessageID
        const targetID = messageID ?? lastMessageID;
        if (!targetID) {
          return { success: false, error: 'No message ID available to react to.' };
        }
        sendToSocket({ type: 'react', emoji, messageID: targetID });
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Ask a question with multiple choice options and WAIT for user response
    async ask(
      question: string,
      options: string[],
      signal?: AbortSignal | null
    ): Promise<{ success: boolean; selection?: string; error?: string }> {
      if (!registered) {
        return { success: false, error: 'Not registered. Call register() first.' };
      }

      if (signal?.aborted) {
        return { success: false, error: signal.reason?.message || 'Aborted' };
      }

      const askID = `ask_${Date.now()}`;

      return new Promise((resolve) => {
        let timeout: any;

        const onAbort = () => {
          if (timeout) clearTimeout(timeout);
          pendingAskResolvers.delete(askID);
          resolve({ success: false, error: signal?.reason?.message || 'Aborted' });
        };

        if (signal) {
          signal.addEventListener('abort', onAbort, { once: true });
        }

        // Store resolver to be called when ask_response arrives
        pendingAskResolvers.set(askID, (selection: string) => {
          if (signal) signal.removeEventListener('abort', onAbort);
          if (timeout) clearTimeout(timeout);
          resolve({ success: true, selection });
        });

        // Send the ask request
        sendToSocket({ type: 'ask', askID, question, options });

        // Timeout after 10 minutes
        timeout = setTimeout(() => {
          if (pendingAskResolvers.has(askID)) {
            pendingAskResolvers.delete(askID);
            if (signal) signal.removeEventListener('abort', onAbort);
            resolve({ success: false, error: 'Question timed out waiting for user response' });
          }
        }, ASK_REQUEST_TIMEOUT_MS);
        timeout.unref();
      });
    },

    // Get current state (no threadID exposed)
    getState(): RelayState {
      return {
        socket,
        registered,
        hasThread,
        sessionID,
        lastMessageID,
        title: currentTitle,
      };
    },

    // Status info (no threadID exposed)
    getStatus() {
      return {
        connected: socket?.writable ?? false,
        registered,
        hasThread,
        sessionID,
        project,
        directory,
        chatId,
      };
    },

    // Fetch config from daemon (chatId, etc.)
    async getConfig(): Promise<{ chatId: string | null }> {
      const s = await ensureSocket();
      return new Promise((resolve) => {
        pendingResolves.set('get_config', (response) => {
          chatId = response.chatId || null;
          resolve({ chatId });
        });
        s.write(JSON.stringify({ type: 'get_config' }) + '\n');
        setTimeout(() => {
          if (pendingResolves.has('get_config')) {
            pendingResolves.delete('get_config');
            resolve({ chatId: null });
          }
        }, CONFIG_FETCH_TIMEOUT_MS);
      });
    },

    // Test-only: simulate a user reaction (for integration tests)
    async simulateReaction(
      messageId: number,
      emoji: string,
      userName: string = 'User'
    ): Promise<void> {
      sendToSocket({ type: 'simulate_reaction', messageId, emoji, userName });
    },

    // Expose sendMessage for direct use (e.g., sending summaries)
    async sendMessage(text: string): Promise<{ success: boolean; error?: string }> {
      return this.send(text);
    },

    // Get daemon health info
    async getHealth(signal?: AbortSignal | null): Promise<{
      success: boolean;
      error?: string;
      pid?: number;
      uptime?: string;
      uptimeMs?: number;
      telegram?: { connected: boolean; botUsername: string };
      sessions?: {
        total: number;
        connected: number;
        idle: number;
        busy: number;
        disconnected: number;
      };
      threads?: number;
      memory?: { heapUsedMB: number; rssMB: number };
    }> {
      try {
        const response = await sendAndWait(
          { type: 'health' },
          'health',
          'relay/core.ts:getHealth',
          signal
        );
        return {
          success: true,
          pid: response.pid,
          uptime: response.uptime,
          uptimeMs: response.uptimeMs,
          telegram: response.telegram,
          sessions: response.sessions,
          threads: response.threads,
          memory: response.memory,
        };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    // Close socket and cleanup for graceful shutdown
    close(): void {
      if (socket) {
        socket.destroy();
        socket = null;
      }
      registered = false;
      hasThread = false;
      sessionID = null;
      pendingResolves.clear();
      pendingPermissionResolvers.clear();
      pendingAskResolvers.clear();
    },
  };
}

export type Relay = ReturnType<typeof createRelay>;

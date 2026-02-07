/**
 * Mock Telegram Bot API Server for Integration Tests
 *
 * Simulates the Telegram Bot API endpoints used by DSR daemon:
 * - sendMessage
 * - createForumTopic
 * - editForumTopic
 * - deleteForumTopic
 * - setMessageReaction
 * - sendChatAction
 * - editMessageText
 * - deleteMessage
 * - answerCallbackQuery
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';

export interface TelegramCall {
  method: string;
  params: Record<string, unknown>;
  timestamp: number;
}

export interface MockTelegramServer {
  server: Server;
  port: number;
  calls: TelegramCall[];
  getUrl: () => string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  reset: () => void;
  // Simulate a user reaction on a message (for testing reaction notifications)
  simulateReaction: (_messageId: number, _emoji: string, _userName?: string) => Promise<void>;
  // Simulate a callback query (for testing button presses like ask/permission)
  simulateCallbackQuery: (_data: string, _messageId: number, _userName?: string) => Promise<void>;
  // Set flag to fail Markdown parsing on next sendMessage
  setMarkdownFailMode: (_fail: boolean) => void;
  // Thread ID counter for consistent thread creation
  nextThreadId: number;
  // Message ID counter
  nextMessageId: number;
}

export function createMockTelegramServer(): MockTelegramServer {
  const calls: TelegramCall[] = [];
  let nextThreadId = 100;
  let nextMessageId = 1000;
  let port = 0;
  let markdownFailMode = false;

  // Store the chat ID that's being used (extracted from API calls)
  let trackedChatId = '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      // Extract method from URL (e.g., /bot<token>/sendMessage -> sendMessage)
      const urlParts = req.url?.split('/') || [];
      const method = urlParts[urlParts.length - 1] || '';

      let params: Record<string, unknown> = {};
      try {
        if (body) {
          params = JSON.parse(body);
        }
      } catch {
        // Ignore parse errors
      }

      // Record the call
      calls.push({
        method,
        params,
        timestamp: Date.now(),
      });

      // Track the chat_id for simulateReaction
      if (params.chat_id) {
        trackedChatId = String(params.chat_id);
      }

      // Generate appropriate response based on method
      let result: unknown = { ok: true };

      switch (method) {
        case 'createForumTopic':
          result = {
            ok: true,
            result: {
              message_thread_id: nextThreadId++,
              name: params.name,
              icon_color: 7322096,
            },
          };
          break;

        case 'sendMessage':
          // Simulate Markdown parsing failure if mode is enabled
          if (markdownFailMode && params.parse_mode === 'Markdown') {
            result = {
              ok: false,
              description:
                "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset X",
            };
            // Only fail once, then reset
            markdownFailMode = false;
          } else {
            result = {
              ok: true,
              result: {
                message_id: nextMessageId++,
                date: Math.floor(Date.now() / 1000),
                chat: { id: params.chat_id },
                text: params.text,
                message_thread_id: params.message_thread_id,
              },
            };
          }
          break;

        case 'editForumTopic':
          result = { ok: true, result: true };
          break;

        case 'deleteForumTopic':
          result = { ok: true, result: true };
          break;

        case 'setMessageReaction':
          result = { ok: true, result: true };
          break;

        case 'sendChatAction':
          result = { ok: true, result: true };
          break;

        case 'editMessageText':
          result = {
            ok: true,
            result: {
              message_id: params.message_id,
              chat: { id: params.chat_id },
              text: params.text,
            },
          };
          break;

        case 'deleteMessage':
          result = { ok: true, result: true };
          break;

        case 'answerCallbackQuery':
          result = { ok: true, result: true };
          break;

        case 'setMyCommands':
          result = { ok: true, result: true };
          break;

        case 'getUpdates':
          // Return pending update if any, otherwise empty
          if (mockServer._pendingReaction) {
            result = { ok: true, result: [mockServer._pendingReaction] };
            mockServer._pendingReaction = null;
          } else if (mockServer._pendingCallbackQuery) {
            result = { ok: true, result: [mockServer._pendingCallbackQuery] };
            mockServer._pendingCallbackQuery = null;
          } else {
            result = { ok: true, result: [] };
          }
          break;

        case 'editMessageReplyMarkup':
          result = { ok: true, result: true };
          break;

        default:
          result = { ok: true, result: {} };
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });

  const mockServer: MockTelegramServer = {
    server,
    port: 0,
    calls,
    nextThreadId,
    nextMessageId,

    getUrl: () => `http://127.0.0.1:${mockServer.port}`,

    start: () => {
      return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          if (addr && typeof addr === 'object') {
            mockServer.port = addr.port;
            resolve();
          } else {
            reject(new Error('Failed to get server address'));
          }
        });
        server.on('error', reject);
      });
    },

    stop: () => {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },

    reset: () => {
      calls.length = 0;
      nextThreadId = 100;
      nextMessageId = 1000;
      trackedChatId = '';
      markdownFailMode = false;
    },

    simulateReaction: async (messageId: number, emoji: string, userName: string = 'User') => {
      // Note: In test mode, polling is disabled, so this just sets up the update
      // for the next getUpdates call. Since polling is disabled, this won't
      // actually be processed by the daemon.
      mockServer._pendingReaction = {
        update_id: Date.now(),
        message_reaction: {
          chat: { id: trackedChatId || '-1001234567890' },
          message_id: messageId,
          user: { id: 1, first_name: userName },
          date: Math.floor(Date.now() / 1000),
          old_reaction: [],
          new_reaction: [{ type: 'emoji', emoji }],
        },
      };
    },

    simulateCallbackQuery: async (data: string, messageId: number, userName: string = 'User') => {
      // Note: Like simulateReaction, this requires polling to work.
      // For callback queries (button presses), we would need polling enabled.
      mockServer._pendingCallbackQuery = {
        update_id: Date.now(),
        callback_query: {
          id: String(Date.now()),
          from: { id: 1, first_name: userName },
          message: {
            message_id: messageId,
            chat: { id: trackedChatId || '-1001234567890' },
          },
          data,
        },
      };
    },

    setMarkdownFailMode: (enabled: boolean) => {
      markdownFailMode = enabled;
    },

    _pendingReaction: null as any,
    _pendingCallbackQuery: null as any,
  };

  return mockServer;
}

// Helper to find calls by method
export function findCalls(calls: TelegramCall[], method: string): TelegramCall[] {
  return calls.filter((c) => c.method === method);
}

// Helper to check if a specific call was made
export function hasCall(
  calls: TelegramCall[],
  method: string,
  paramsMatcher?: Partial<Record<string, unknown>>
): boolean {
  return calls.some((c) => {
    if (c.method !== method) return false;
    if (!paramsMatcher) return true;
    for (const [key, value] of Object.entries(paramsMatcher)) {
      if (c.params[key] !== value) return false;
    }
    return true;
  });
}

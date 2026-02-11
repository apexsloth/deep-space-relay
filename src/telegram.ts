import { EventEmitter } from 'node:events';
import { log } from './daemon/logger';
import {
  MS_PER_SECOND,
  HTTP_TOO_MANY_REQUESTS,
  SECONDS_PER_HOUR,
  BACKOFF_BASE_DELAY_MS,
  TELEGRAM_ERROR_RETRY_MS,
  TELEGRAM_SUCCESS_DELAY_MS,
} from './constants';

export interface TelegramConfig {
  botToken: string;
  apiUrl?: string;
  maxRequestsPerSecond?: number; // Default 30
  onError?: (message: string) => void; // Error callback instead of console
}

/**
 * Token bucket rate limiter for Telegram API (30 req/s limit)
 */
class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(maxRequestsPerSecond: number = 30) {
    this.maxTokens = maxRequestsPerSecond;
    this.tokens = maxRequestsPerSecond;
    this.refillRate = maxRequestsPerSecond / MS_PER_SECOND;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    // Wait for token to become available
    const waitTime = Math.ceil((1 - this.tokens) / this.refillRate);
    await new Promise((resolve) => setTimeout(resolve, waitTime));
    this.refill();
    this.tokens -= 1;
  }

  /** Try to acquire a token without waiting. Returns false if rate limited. */
  tryAcquire(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}

export interface Update {
  update_id: number;
  message?: any;
  callback_query?: any;
  message_reaction?: any;
}

export class TelegramClient extends EventEmitter {
  private botToken: string;
  private apiUrl: string;
  private offset: number = 0;
  private isPolling: boolean = false;
  private rateLimiter: RateLimiter;
  private onError: (message: string) => void;

  constructor(config: TelegramConfig) {
    super();
    this.botToken = config.botToken;
    this.apiUrl = config.apiUrl || `https://api.telegram.org/bot${this.botToken}`;
    this.rateLimiter = new RateLimiter(config.maxRequestsPerSecond ?? 30);
    this.onError = config.onError ?? (() => {}); // Silent by default
  }

  /**
   * Call Telegram API with rate limiting and exponential backoff for 429s
   * @param method - Telegram API method
   * @param params - API parameters
   * @param options - { retries: number, dropOnRateLimit: boolean }
   */
  async callApi(
    method: string,
    params: any = {},
    options: { retries?: number; dropOnRateLimit?: boolean } = {}
  ): Promise<any> {
    const { retries = 3, dropOnRateLimit = false } = options;

    // For droppable requests (typing indicators), check if we can proceed immediately
    if (dropOnRateLimit && !this.rateLimiter.tryAcquire()) {
      return { ok: true, dropped: true }; // Silently drop
    } else if (!dropOnRateLimit) {
      await this.rateLimiter.acquire();
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(`${this.apiUrl}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });

        const data = await res.json();

        // Handle 429 Too Many Requests with retry-after
        if (res.status === HTTP_TOO_MANY_REQUESTS || data.error_code === HTTP_TOO_MANY_REQUESTS) {
          const rawRetryAfter = data.parameters?.retry_after || Math.pow(2, attempt + 1);
          // Cap retry to 60s - if Telegram says longer, we're banned and should fail fast
          if (rawRetryAfter > 60) {
            this.onError(
              `[Telegram] ${method}: Rate limited for ${rawRetryAfter}s (${Math.round(rawRetryAfter / SECONDS_PER_HOUR)}h) - too long, failing`
            );
            return {
              ok: false,
              error_code: HTTP_TOO_MANY_REQUESTS,
              description: `Rate limited for ${rawRetryAfter}s`,
              banned: true,
            };
          }
          this.onError(
            `[Telegram] ${method}: Rate limited, waiting ${rawRetryAfter}s (attempt ${attempt + 1}/${retries + 1})`
          );
          if (attempt < retries) {
            await new Promise((resolve) => setTimeout(resolve, rawRetryAfter * MS_PER_SECOND));
            continue;
          }
        }

        return data;
      } catch (err: any) {
        this.onError(`[Telegram] API error on ${method}: ${err.message}`);
        if (attempt < retries) {
          const backoff = Math.pow(2, attempt + 1) * BACKOFF_BASE_DELAY_MS; // 200ms, 400ms, 800ms
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        throw err;
      }
    }
  }

  async startPolling(timeout: number = 50) {
    if (this.isPolling) return;
    this.isPolling = true;
    this.onError(`[Telegram] Starting polling loop (offset: ${this.offset})`);

    while (this.isPolling) {
      try {
        const res = await this.callApi('getUpdates', {
          offset: this.offset,
          timeout,
          allowed_updates: ['message', 'callback_query', 'message_reaction'],
        });

        if (res.ok && res.result.length > 0) {
          for (const update of res.result) {
            this.handleUpdate(update);
            this.offset = update.update_id + 1;
          }
        }
      } catch (err: any) {
        this.onError(`[Telegram] Polling error: ${err.message}`);
        await new Promise((resolve) => setTimeout(resolve, TELEGRAM_ERROR_RETRY_MS));
      }
      await new Promise((resolve) => setTimeout(resolve, TELEGRAM_SUCCESS_DELAY_MS));
    }
  }

  stopPolling() {
    this.isPolling = false;
  }

  private handleUpdate(update: Update) {
    log(`[Telegram] Incoming update: ${JSON.stringify(update)}`, 'debug');
    if (update.message) {
      this.emit('message', update.message);
    }
    if (update.callback_query) {
      this.emit('callback_query', update.callback_query);
    }
    if (update.message_reaction) {
      this.emit('message_reaction', update.message_reaction);
    }
  }

  // Helper methods for common actions
  async sendMessage(params: any) {
    return this.callApi('sendMessage', params);
  }
  async sendChatAction(params: any) {
    // Typing indicators are low priority - drop if rate limited
    return this.callApi('sendChatAction', params, { dropOnRateLimit: true });
  }
  async setMessageReaction(params: any) {
    return this.callApi('setMessageReaction', params);
  }
  async createForumTopic(params: any) {
    return this.callApi('createForumTopic', params);
  }
  async editForumTopic(params: any) {
    return this.callApi('editForumTopic', params);
  }
  async deleteForumTopic(params: any) {
    return this.callApi('deleteForumTopic', params);
  }
  async deleteMessage(params: any) {
    return this.callApi('deleteMessage', params);
  }
  async answerCallbackQuery(params: any) {
    return this.callApi('answerCallbackQuery', params);
  }
  async editMessageText(params: any) {
    return this.callApi('editMessageText', params);
  }
  async editMessageReplyMarkup(params: any) {
    return this.callApi('editMessageReplyMarkup', params);
  }
  async getChat(params: any) {
    return this.callApi('getChat', params);
  }
  async setMyCommands(params: any) {
    return this.callApi('setMyCommands', params);
  }
  async pinChatMessage(params: any) {
    return this.callApi('pinChatMessage', params);
  }
  async unpinChatMessage(params: any) {
    return this.callApi('unpinChatMessage', params);
  }

  async getUpdates(params: any): Promise<Update[]> {
    const res = await this.callApi('getUpdates', params);
    if (res.ok) {
      return res.result;
    }
    return [];
  }

  processUpdate(update: Update) {
    this.handleUpdate(update);
  }
}

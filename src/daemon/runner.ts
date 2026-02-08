import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { TelegramClient } from '../telegram';
import { LifecycleCoordinator } from './lifecycle';
import { loadConfig, validateConfig, getSystemConfigDir, getPIDPath } from '../config';
import { log, configureLogger, type LogLevel } from './logger';
import {
  createState,
  createSocketServer,
  ensureThread,
  configureBot,
  createMessageHandler,
  createCallbackQueryHandler,
  createReactionHandler,
  cleanupOldSessions,
} from './index';
import { ConfigManager } from './config-manager';
import { SYSTEM_TOKEN_PATH } from './setup';
import type { DaemonRunOptions } from './worker-types';
import {
  STANDBY_RETRY_MS,
  PARSE_INT_RADIX,
  RETRY_DELAY_MS,
  LONG_RETRY_DELAY_MS,
  SHORT_DELAY_MS,
  POLLING_INITIAL_BACKOFF_MS,
  POLLING_MAX_BACKOFF_MS,
  POLLING_BACKOFF_MULTIPLIER,
} from '../constants';

export async function runDaemon(options: DaemonRunOptions): Promise<void> {
  const PID_FILE = getPIDPath();

  // Check for configuration (skip in test mode)
  if (!options.testMode && !existsSync(SYSTEM_TOKEN_PATH)) {
    throw new Error(
      'No configuration found. Run "dsr setup" or "npx deep-space-relay setup" to configure your Telegram bot.'
    );
  }

  const {
    socketPath,
    statePath,
    projectPath,
    configPath: configPathOverride,
    token: tokenOverride,
    chatId: chatIdOverride,
    ipcToken: ipcTokenOverride,
    telegramApiUrl,
    logFile,
    testMode = false,
    forceMode = false,
    standbyRetryMs = STANDBY_RETRY_MS,
    onLog = () => {},
    onLeader = () => {},
    onStandby = () => {},
    onReady = () => {},
    onError = () => {},
    signal,
  } = options;

  // Configure unified logger for standalone mode
  const logCleanup = configureLogger({
    logFile,
  });

  // For force mode, we need the IPC token early to shutdown the existing leader
  let effectiveIpcToken = ipcTokenOverride;
  if (forceMode && !effectiveIpcToken) {
    // Try to load token from system token path
    try {
      const { SYSTEM_TOKEN_PATH } = require('./setup');
      log(`Looking for token at: \${SYSTEM_TOKEN_PATH}`, 'debug');
      if (existsSync(SYSTEM_TOKEN_PATH)) {
        const tokenData = JSON.parse(require('node:fs').readFileSync(SYSTEM_TOKEN_PATH, 'utf-8'));
        effectiveIpcToken = tokenData.token;
        log(
          `Loaded IPC token for force takeover (\${effectiveIpcToken ? 'found' : 'empty'})`,
          'debug'
        );
      } else {
        log(`Token file not found: \${SYSTEM_TOKEN_PATH}`, 'debug');
      }
    } catch (err) {
      log(`Could not load token for force takeover: \${err}`, 'warn');
    }
  }

  const lifecycle = new LifecycleCoordinator({
    socketPath,
    standbyRetryMs,
    forceMode,
    pidFile: PID_FILE,
    onLog: (level, message, extra) => log(message, level, extra),
    signal,
    ipcToken: effectiveIpcToken,
  });

  let leaderStarted = false;
  let server: ReturnType<typeof createSocketServer> | undefined;
  let pollingActive = false;
  let bot: TelegramClient | undefined;

  const startLeader = async (reason: string) => {
    if (leaderStarted) return;
    leaderStarted = true;
    onLeader(reason);

    try {
      log(`Starting Leader services (reason: \${reason})`, 'info');

      log('Loading configuration', 'debug');
      let config: { token?: string; chatId?: string; ipcToken?: string };
      if (testMode) {
        config = {
          token: tokenOverride || 'test-bot-token',
          chatId: chatIdOverride || '',
          ipcToken: ipcTokenOverride,
        };
        if (configPathOverride && existsSync(configPathOverride)) {
          try {
            const testConfig = JSON.parse(
              require('node:fs').readFileSync(configPathOverride, 'utf-8')
            );
            if (testConfig.token && !tokenOverride) config.token = testConfig.token;
            if (testConfig.chatId) config.chatId = testConfig.chatId;
            if (testConfig.ipcToken && !config.ipcToken) config.ipcToken = testConfig.ipcToken;
          } catch (err) {
            // Expected: test config may not exist or be malformed in test mode
            log(`Could not load test config override: ${err}`, 'debug');
          }
        }
      } else {
        config = loadConfig(projectPath);
        if (tokenOverride) config.token = tokenOverride;
        if (chatIdOverride) config.chatId = chatIdOverride;
        if (ipcTokenOverride) config.ipcToken = ipcTokenOverride;
      }

      const { valid, missing } = validateConfig(config);
      if (!testMode && !valid) {
        throw new Error(`Missing configuration: \${missing.join(', ')}`);
      }

      let chatId = config.chatId || '';
      const configPath =
        configPathOverride ||
        (projectPath ? join(projectPath, '.opencode/deep-space-relay/config.json') : '');
      const configManager = new ConfigManager(configPath);

      // Use bot token for IPC auth - already shared between daemon and clients
      const ipcToken = config.token || '';

      bot = new TelegramClient({
        botToken: config.token || '',
        apiUrl: telegramApiUrl,
        onError: (msg) => log(msg, 'warn'),
      });

      const state = createState(statePath);

      // Run cleanup on startup to remove old disconnected sessions
      log('Running auto-cleanup for old disconnected sessions', 'info');
      cleanupOldSessions(state, statePath, bot, chatId).catch((err) => {
        // Auto-cleanup failure is non-critical at startup
        log(`Auto-cleanup failed: ${err}`, 'error');
      });

      const getChatId = () => chatId;
      const setChatId = (id: string) => {
        chatId = id;
      };
      const boundEnsureThread = (
        sessionID: string,
        project: string,
        title: string,
        sessionChatId?: string
      ) => ensureThread(sessionID, project, title, state, statePath, bot, sessionChatId || chatId);

      const getListenOptions = () => {
        if (/^\d+$/.test(socketPath)) {
          return { port: parseInt(socketPath, PARSE_INT_RADIX), host: '127.0.0.1' };
        }
        return socketPath;
      };

      const createAndListen = async () => {
        server = createSocketServer(
          socketPath,
          state,
          statePath,
          bot,
          getChatId,
          boundEnsureThread,
          ipcToken
        );
        server.on('error', (err: any) => {
          log(`Socket server error: \${err.message}`, 'error');
          if (!server?.listening) {
            leaderStarted = false;
            lifecycle.reportLeaderFailure(err);
          }
        });

        await new Promise<void>((resolve, reject) => {
          server!.once('listening', () => resolve());
          server!.once('error', reject);
          server!.listen(getListenOptions());
        });
      };

      try {
        await createAndListen();
      } catch (err: any) {
        if (err.code === 'EADDRINUSE' && !/^\d+$/.test(socketPath)) {
          log('Socket in use, checking if leader is alive', 'warn');
          const alive = await lifecycle.checkLeaderAlive();
          if (!alive) {
            log('Zombie socket detected, cleaning up and retrying', 'warn');
            try {
              unlinkSync(socketPath);
            } catch (unlinkErr) {
              // Socket file may already be gone, continue anyway
              log(`Could not unlink zombie socket: ${unlinkErr}`, 'debug');
            }
            await createAndListen();
          } else {
            throw err;
          }
        } else {
          throw err;
        }
      }

      log('Socket server listening', 'info');

      // Write PID file for force takeover
      try {
        writeFileSync(PID_FILE, String(process.pid));
        log(`PID file written: \${PID_FILE}`, 'debug');
      } catch (err) {
        log(`Failed to write PID file: \${err}`, 'warn');
      }

      configureBot(bot, chatId).catch((err) => log(`Bot config failed: \${err}`, 'error'));
      bot.on(
        'message',
        createMessageHandler(bot, state, statePath, configManager, getChatId, setChatId)
      );
      bot.on('callback_query', createCallbackQueryHandler(bot, state, statePath));
      bot.on('message_reaction', createReactionHandler(state));

      if (!testMode) {
        pollingActive = true;
        (async () => {
          let offset = 0;
          let errorBackoffMs = POLLING_INITIAL_BACKOFF_MS;
          while (pollingActive && !signal?.aborted) {
            try {
              const updates = await bot.getUpdates({
                offset,
                timeout: 50,
                allowed_updates: ['message', 'callback_query', 'message_reaction'] as any,
              });
              for (const update of updates) {
                await bot.processUpdate(update);
                offset = update.update_id + 1;
              }
              // Reset backoff on successful poll
              errorBackoffMs = POLLING_INITIAL_BACKOFF_MS;
              await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
            } catch (err) {
              log('Polling error', 'error', { error: String(err), backoffMs: errorBackoffMs });
              await new Promise((r) => setTimeout(r, errorBackoffMs));
              // Exponential backoff: double the delay, cap at max
              errorBackoffMs = Math.min(
                errorBackoffMs * POLLING_BACKOFF_MULTIPLIER,
                POLLING_MAX_BACKOFF_MS
              );
            }
          }
        })();
      }

      log('Started as Leader', 'info');
      lifecycle.confirmLeading({ reason });
      onReady(true, socketPath);
    } catch (err: any) {
      leaderStarted = false;
      log(`Failed to start Leader services: \${err.message}`, 'error');
      lifecycle.reportLeaderFailure(err);
    }
  };

  lifecycle.on('become_leader', (extra) => {
    startLeader(extra?.reason || 'takeover').catch((err) => {
      log('Fatal error during leader transition', 'error', { error: String(err) });
    });
  });

  lifecycle.on('become_standby', (extra) => {
    onStandby(standbyRetryMs);
  });

  const cleanup = () => {
    log('Shutting down daemon', 'info');
    pollingActive = false;
    if (bot) bot.stopPolling(); // Stop any active polling
    if (server) {
      try {
        server.close();
      } catch {}
    }
    lifecycle.cleanupSocket();
    // Remove PID file
    try {
      if (existsSync(PID_FILE)) {
        log(`Removing PID file: \${PID_FILE}`, 'debug');
        unlinkSync(PID_FILE);
      }
    } catch (err) {
      // Best-effort cleanup during shutdown, continue anyway
      log(`Could not remove PID file during shutdown: ${err}`, 'debug');
    }
    logCleanup?.();
    // Force exit after brief delay - polling may be stuck in long-poll
    setTimeout(() => process.exit(0), SHORT_DELAY_MS);
  };

  // Attach crash handlers
  process.once('uncaughtException', (err) => {
    log('Uncaught exception, shutting down', 'error', { error: String(err) });
    cleanup();
  });
  process.once('unhandledRejection', (reason) => {
    log('Unhandled rejection, shutting down', 'error', { reason: String(reason) });
    cleanup();
  });

  if (signal) {
    signal.addEventListener('abort', cleanup, { once: true });
  }

  await lifecycle.start();

  // Wait for signal or keep process alive
  if (signal) {
    if (signal.aborted) {
      cleanup();
    } else {
      await new Promise((resolve) => {
        signal.addEventListener('abort', resolve, { once: true });
      });
    }
  } else {
    await new Promise((resolve) => {
      const handleSignal = () => {
        cleanup();
        resolve(null);
      };
      process.on('SIGINT', handleSignal);
      process.on('SIGTERM', handleSignal);
    });
  }
}

export function createDaemonController(): AbortController {
  return new AbortController();
}

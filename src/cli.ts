#!/usr/bin/env node
/**
 * Deep Space Relay CLI
 *
 * Usage:
 *   dsr setup   - Configure bot token and chat ID
 *   dsr start   - Start the daemon (foreground)
 *   dsr status  - Check daemon status
 *   dsr stop    - Stop the daemon
 *   dsr help    - Show this help
 */

/* eslint-disable no-console */

import { connect, type Socket } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout, clearTimeout } from 'node:timers';
import { setup, UserCancelledError, ANSI, SYSTEM_TOKEN_PATH } from './daemon/setup.ts';
import { runDaemon } from './daemon/runner.ts';
import { getSystemConfigDir, getSocketPath, getPIDPath } from './config.ts';
import {
  CLI_CONNECT_TIMEOUT_MS,
  CLI_COMMAND_TIMEOUT_MS,
  MS_PER_SECOND,
  SECONDS_PER_MINUTE,
  SECONDS_PER_HOUR,
} from './constants';

// ============================================================
// CONSTANTS
// ============================================================

const SOCKET_PATH = getSocketPath();
const STATE_PATH = join(getSystemConfigDir(), 'state.json');
const SYSTEM_CONFIG_PATH = join(getSystemConfigDir(), 'config.json');
const PID_FILE = getPIDPath();

// ============================================================
// HELPERS
// ============================================================

function style(text: string, ...styles: string[]): string {
  return styles.join('') + text + ANSI.reset;
}

function configExists(): boolean {
  // Check system-wide config (not project-specific)
  return existsSync(SYSTEM_TOKEN_PATH) && existsSync(SYSTEM_CONFIG_PATH);
}

function showHelp(): void {
  console.log(`
${style('Deep Space Relay', ANSI.cyan, ANSI.bold)} - Telegram bridge for OpenCode

${style('Usage:', ANSI.bold)} dsr <command>

${style('Commands:', ANSI.bold)}
  ${style('setup', ANSI.green)}   Configure bot token and chat ID
  ${style('start', ANSI.green)}   Start the daemon (foreground) [--force]
  ${style('status', ANSI.green)}  Check daemon status
  ${style('stop', ANSI.green)}    Stop the daemon
  ${style('help', ANSI.green)}    Show this help

Run '${style('dsr setup', ANSI.cyan)}' first to configure your Telegram bot.
`);
}

/**
 * Connect to daemon socket and send a command
 */
function connectToDaemon(timeout = CLI_CONNECT_TIMEOUT_MS): Promise<Socket> {
  return new Promise((resolve, reject) => {
    if (!existsSync(SOCKET_PATH)) {
      reject(new Error('Daemon not running (socket not found)'));
      return;
    }

    const socket = connect(SOCKET_PATH);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Connection timeout'));
    }, timeout);

    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Send a message to daemon and get response
 * Handles authentication automatically if token is available
 */
async function sendCommand(
  command: object,
  timeout = CLI_COMMAND_TIMEOUT_MS
): Promise<object | null> {
  const socket = await connectToDaemon(timeout);

  return new Promise((resolve, reject) => {
    let buffer = '';

    // Load IPC token from system config
    let ipcToken: string | undefined;
    if (existsSync(SYSTEM_TOKEN_PATH)) {
      try {
        const tokenData = JSON.parse(readFileSync(SYSTEM_TOKEN_PATH, 'utf-8'));
        ipcToken = tokenData.token;
      } catch {
        // Expected: token file may not exist or be malformed on first run
      }
    }

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Response timeout'));
    }, timeout);

    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const resp = JSON.parse(line);

          if (resp.type === 'auth_ack') {
            if (resp.success) {
              // Now send the actual command
              socket.write(JSON.stringify(command) + '\n');
              continue;
            } else {
              clearTimeout(timer);
              socket.end();
              reject(new Error(`Authentication failed: ${resp.error}`));
              return;
            }
          }

          clearTimeout(timer);
          socket.end();
          resolve(resp);
          return;
        } catch {
          // Continue waiting for valid JSON
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.on('close', () => {
      clearTimeout(timer);
      resolve(null);
    });

    // Start with auth if we have a token
    if (ipcToken) {
      socket.write(JSON.stringify({ type: 'auth', token: ipcToken }) + '\n');
    } else {
      socket.write(JSON.stringify(command) + '\n');
    }
  });
}

// ============================================================
// COMMANDS
// ============================================================

async function cmdSetup(): Promise<void> {
  try {
    // Don't pass projectPath so the setup function prompts for it
    await setup();
  } catch (err) {
    if (err instanceof UserCancelledError) {
      console.log(style('\nSetup cancelled.', ANSI.yellow));
      process.exit(0);
    }
    throw err;
  }
}

async function cmdStart(forceMode = false): Promise<void> {
  // Check system-wide config
  if (!configExists()) {
    console.log(style('Error:', ANSI.red, ANSI.bold) + ' No configuration found.');
    console.log(`Run '${style('dsr setup', ANSI.cyan)}' first to configure your Telegram bot.\n`);
    process.exit(1);
  }

  if (forceMode) {
    console.log(style('Force mode enabled', ANSI.yellow) + ' - will take over from existing daemon');
  }

  console.log(style('Starting Deep Space Relay daemon...', ANSI.cyan));
  console.log(style('Press Ctrl+C to stop.\n', ANSI.dim));

  try {
    await runDaemon({
      socketPath: SOCKET_PATH,
      statePath: STATE_PATH,
      projectPath: process.cwd(),
      forceMode,
      onLeader: (reason) => {
        console.log(style('Started as leader', ANSI.green) + ` (${reason})`);
      },
      onStandby: (retryMs) => {
        console.log(
          style('Another instance is running.', ANSI.yellow) +
            ` Waiting in standby (retry in ${retryMs / MS_PER_SECOND}s)...`
        );
      },
      onReady: (isLeader, socketPath) => {
        if (isLeader) {
          console.log(
            style('Daemon ready', ANSI.green, ANSI.bold) + ` - listening on ${socketPath}`
          );
        }
      },
      onError: (err) => {
        console.error(style('Error:', ANSI.red) + ` ${err}`);
      },
    });
  } catch (err) {
    console.error(style('Failed to start daemon:', ANSI.red), err);
    process.exit(1);
  }
}

async function cmdStatus(): Promise<void> {
  try {
    const response = await sendCommand({ type: 'health' });

    if (!response) {
      console.log(style('Daemon not running', ANSI.yellow));
      process.exit(1);
    }

    const resp = response as any;

    if (resp.type === 'health_response') {
      console.log(style('Daemon Status:', ANSI.cyan, ANSI.bold));
      console.log(`  ${style('Status:', ANSI.bold)} ${style('Running', ANSI.green)}`);

      if (resp.uptimeMs !== undefined) {
        const uptime = Math.floor(resp.uptimeMs / MS_PER_SECOND);
        const hours = Math.floor(uptime / SECONDS_PER_HOUR);
        const minutes = Math.floor((uptime % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
        const seconds = uptime % SECONDS_PER_MINUTE;
        console.log(`  ${style('Uptime:', ANSI.bold)} ${hours}h ${minutes}m ${seconds}s`);
      } else if (resp.uptime) {
        console.log(`  ${style('Uptime:', ANSI.bold)} ${resp.uptime}`);
      }

      if (resp.sessions) {
        console.log(
          `  ${style('Active Sessions:', ANSI.bold)} ${resp.sessions.connected} / ${resp.sessions.total}`
        );
      }

      if (resp.telegram) {
        const tgStatus = resp.telegram.connected
          ? style('Connected', ANSI.green)
          : style('Disconnected', ANSI.red);
        console.log(
          `  ${style('Telegram:', ANSI.bold)} ${tgStatus} (@${resp.telegram.botUsername})`
        );
      }

      if (resp.memory) {
        console.log(
          `  ${style('Memory:', ANSI.bold)} ${resp.memory.heapUsedMB} MB / ${resp.memory.rssMB} MB RSS`
        );
      }
    } else {
      console.log(style('Daemon running', ANSI.green) + ' (unknown response format)');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes('not running') ||
      message.includes('ENOENT') ||
      message.includes('ECONNREFUSED')
    ) {
      console.log(style('Daemon not running', ANSI.yellow));

      if (existsSync(PID_FILE)) {
        try {
          const pid = readFileSync(PID_FILE, 'utf-8').trim();
          console.log(style(`  (stale PID file found: ${pid})`, ANSI.dim));
        } catch {
          // Expected: PID file may not exist or be unreadable
        }
      }
    } else {
      console.log(style('Error checking status:', ANSI.red) + ` ${message}`);
    }
    process.exit(1);
  }
}

async function cmdStop(): Promise<void> {
  try {
    console.log(style('Sending shutdown signal...', ANSI.cyan));
    const response = await sendCommand({ type: 'shutdown' });

    if (response && (response as any).type === 'shutdown_ack') {
      console.log(style('Daemon stopped', ANSI.green));
    } else {
      console.log(style('Shutdown signal sent', ANSI.green));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (
      message.includes('not running') ||
      message.includes('ENOENT') ||
      message.includes('ECONNREFUSED')
    ) {
      console.log(style('Daemon not running', ANSI.yellow));
    } else {
      console.log(style('Error stopping daemon:', ANSI.red) + ` ${message}`);

      if (existsSync(PID_FILE)) {
        try {
          const pid = readFileSync(PID_FILE, 'utf-8').trim();
          console.log(`\nYou can manually stop it with: ${style(`kill ${pid}`, ANSI.cyan)}`);
        } catch {
          // Expected: PID file may not exist or be unreadable
        }
      }
      process.exit(1);
    }
  }
}

// ============================================================
// MAIN
// ============================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const flags = new Set(args.slice(1));
  const forceMode = flags.has('--force') || flags.has('-f');

  switch (command) {
    case 'setup':
      await cmdSetup();
      break;

    case 'start':
      await cmdStart(forceMode);
      break;

    case 'status':
      await cmdStatus();
      break;

    case 'stop':
      await cmdStop();
      break;

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      showHelp();
      break;

    default:
      console.log(style(`Unknown command: ${command}`, ANSI.red));
      showHelp();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(style('Error:', ANSI.red, ANSI.bold), err.message || err);
  process.exit(1);
});

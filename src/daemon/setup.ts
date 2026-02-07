#!/usr/bin/env bun
/**
 * Deep Space Relay - Interactive Setup Utility
 *
 * Zero-dependency ANSI terminal UI for configuring DSR.
 * Run with: bun run src/daemon/setup.ts
 */

/* eslint-disable no-undef */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

// ============================================================
// CUSTOM ERRORS
// ============================================================

/**
 * Thrown when user cancels an interactive prompt (e.g., Ctrl+C)
 */
export class UserCancelledError extends Error {
  constructor(message: string = 'User cancelled') {
    super(message);
    this.name = 'UserCancelledError';
  }
}

// ============================================================
// EXPORTED CONSTANTS
// ============================================================

// System-level token path (uses underscore for backward compatibility)
export const SYSTEM_TOKEN_PATH = join(
  process.env.HOME || '',
  '.config/opencode/deep-space-relay/token.json'
);

// Subdirectory within .opencode for DSR config
export const DSR_CONFIG_SUBDIR = '.opencode/deep-space-relay';

// ============================================================
// ANSI ESCAPE CODES
// ============================================================

export const ANSI = {
  // Cursor control
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  cursorUp: (n: number) => `\x1b[${n}A`,
  cursorDown: (n: number) => `\x1b[${n}B`,
  cursorTo: (col: number) => `\x1b[${col}G`,
  clearLine: '\x1b[2K',
  clearToEnd: '\x1b[0J',

  // Colors
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Bright colors
  brightBlack: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

// ============================================================
// KEY PARSING
// ============================================================

export type KeyEvent = {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  char?: string;
};

function parseKey(buf: Buffer): KeyEvent {
  const str = buf.toString();

  // Special keys
  if (buf[0] === 0x03) return { name: 'c', ctrl: true, meta: false, shift: false };
  if (buf[0] === 0x04) return { name: 'd', ctrl: true, meta: false, shift: false };
  if (buf[0] === 0x1b) {
    if (buf.length === 1) return { name: 'escape', ctrl: false, meta: false, shift: false };
    if (buf[1] === 0x5b) {
      // Arrow keys
      if (buf[2] === 0x41) return { name: 'up', ctrl: false, meta: false, shift: false };
      if (buf[2] === 0x42) return { name: 'down', ctrl: false, meta: false, shift: false };
      if (buf[2] === 0x43) return { name: 'right', ctrl: false, meta: false, shift: false };
      if (buf[2] === 0x44) return { name: 'left', ctrl: false, meta: false, shift: false };
    }
  }
  if (buf[0] === 0x0d || buf[0] === 0x0a)
    return { name: 'return', ctrl: false, meta: false, shift: false };
  if (buf[0] === 0x7f) return { name: 'backspace', ctrl: false, meta: false, shift: false };
  if (buf[0] === 0x09) return { name: 'tab', ctrl: false, meta: false, shift: false };
  if (buf[0] === 0x20) return { name: 'space', ctrl: false, meta: false, shift: false, char: ' ' };

  // Regular printable characters
  if (str.length === 1 && buf[0] >= 0x20 && buf[0] <= 0x7e) {
    return { name: str, ctrl: false, meta: false, shift: false, char: str };
  }

  // Multi-byte UTF-8 characters
  if (str.length > 0) {
    return { name: str, ctrl: false, meta: false, shift: false, char: str };
  }

  return { name: 'unknown', ctrl: false, meta: false, shift: false };
}

/**
 * Drain any buffered input from stdin
 */
async function drainStdin(): Promise<void> {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise((resolve, reject) => {
    // Give a tiny window to drain buffered data
    // eslint-disable-next-line no-unused-vars
    const timeoutId = setTimeout(() => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      resolve();
    }, 50);

    const onData = () => {
      // Just consume and ignore buffered data
    };

    stdin.on('data', onData);
  });
}

// ============================================================
// UI PRIMITIVES
// ============================================================

function write(text: string) {
  process.stdout.write(text);
}

function writeln(text: string = '') {
  process.stdout.write(text + '\n');
}

function style(text: string, ...styles: string[]): string {
  return styles.join('') + text + ANSI.reset;
}

async function waitForKey(): Promise<KeyEvent> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.once('data', (data) => {
      stdin.setRawMode(false);
      stdin.pause();
      resolve(parseKey(data));
    });
  });
}

// ============================================================
// INPUT WIDGETS
// ============================================================

/**
 * Secret input - shows asterisks instead of actual characters
 */
export async function inputSecret(prompt: string): Promise<string> {
  write(style(prompt, ANSI.cyan, ANSI.bold) + ' ');

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();

  let value = '';
  let cursorPos = 0;

  const render = () => {
    write(ANSI.cursorTo(prompt.length + 2));
    write(ANSI.clearToEnd);
    write(style('*'.repeat(value.length), ANSI.yellow));
  };

  return new Promise((resolve, reject) => {
    const onData = (data: Buffer) => {
      const key = parseKey(data);

      if (key.ctrl && key.name === 'c') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        writeln();
        reject(new UserCancelledError());
        return;
      }

      if (key.name === 'return') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        writeln();
        resolve(value);
        return;
      }

      if (key.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
          cursorPos = Math.max(0, cursorPos - 1);
        }
      } else if (key.char) {
        value += key.char;
        cursorPos++;
      }

      render();
    };

    stdin.on('data', onData);
    render();
  });
}

/**
 * Regular text input - exported for future use
 */
export async function input(prompt: string, defaultValue: string = ''): Promise<string> {
  // Drain any leftover buffered input first
  await drainStdin();

  const defaultHint = defaultValue ? style(` (${defaultValue})`, ANSI.dim) : '';
  write(style(prompt, ANSI.cyan, ANSI.bold) + defaultHint + ' ');

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();

  let value = '';

  const render = () => {
    const displayPrompt = prompt + (defaultValue ? ` (${defaultValue})` : '') + ' ';
    write(ANSI.cursorTo(displayPrompt.length + 1));
    write(ANSI.clearToEnd);
    write(style(value, ANSI.white));
  };

  return new Promise((resolve, reject) => {
    const onData = (data: Buffer) => {
      const key = parseKey(data);

      if (key.ctrl && key.name === 'c') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        writeln();
        reject(new UserCancelledError());
        return;
      }

      if (key.name === 'return') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        writeln();
        resolve(value || defaultValue);
        return;
      }

      if (key.name === 'backspace') {
        if (value.length > 0) {
          value = value.slice(0, -1);
        }
      } else if (key.char) {
        value += key.char;
      }

      render();
    };

    stdin.on('data', onData);
    render();
  });
}

/**
 * Selection menu with arrow keys - exported for future use
 */
export async function select<T extends string>(
  prompt: string,
  options: { label: string; value: T }[]
): Promise<T> {
  writeln(style(prompt, ANSI.cyan, ANSI.bold));

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();

  let selectedIndex = 0;

  const render = () => {
    // Move up to redraw
    if (selectedIndex > 0 || options.length > 1) {
      write(ANSI.cursorUp(options.length));
    }

    for (let i = 0; i < options.length; i++) {
      write(ANSI.clearLine);
      if (i === selectedIndex) {
        writeln(style(`  ❯ ${options[i].label}`, ANSI.green, ANSI.bold));
      } else {
        writeln(style(`    ${options[i].label}`, ANSI.dim));
      }
    }
  };

  // Initial render
  for (let i = 0; i < options.length; i++) {
    if (i === selectedIndex) {
      writeln(style(`  ❯ ${options[i].label}`, ANSI.green, ANSI.bold));
    } else {
      writeln(style(`    ${options[i].label}`, ANSI.dim));
    }
  }

  return new Promise((resolve, reject) => {
    const onData = (data: Buffer) => {
      const key = parseKey(data);

      if (key.ctrl && key.name === 'c') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        write(ANSI.showCursor);
        writeln();
        reject(new UserCancelledError());
        return;
      }

      if (key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        render();
      } else if (key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % options.length;
        render();
      } else if (key.name === 'return') {
        stdin.removeListener('data', onData);
        stdin.setRawMode(false);
        stdin.pause();
        write(ANSI.showCursor);
        resolve(options[selectedIndex].value);
      }
    };

    write(ANSI.hideCursor);
    stdin.on('data', onData);
  });
}

/**
 * Yes/No confirmation
 */
export async function confirm(prompt: string, defaultYes: boolean = true): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  write(style(prompt, ANSI.cyan, ANSI.bold) + ' ' + style(hint, ANSI.dim) + ' ');

  const key = await waitForKey();

  if (key.ctrl && key.name === 'c') {
    writeln();
    throw new UserCancelledError();
  }

  if (key.name === 'return') {
    writeln(defaultYes ? 'Yes' : 'No');
    return defaultYes;
  }

  if (key.name === 'y' || key.name === 'Y') {
    writeln('Yes');
    return true;
  }

  if (key.name === 'n' || key.name === 'N') {
    writeln('No');
    return false;
  }

  // Invalid key - loop until valid input
  return confirm(prompt, defaultYes);
}

// ============================================================
// TELEGRAM API HELPERS (minimal, inline)
// ============================================================

export interface BotInfo {
  ok: boolean;
  result?: {
    id: number;
    is_bot: boolean;
    first_name: string;
    username: string;
    can_join_groups: boolean;
    can_read_all_group_messages: boolean;
    supports_inline_queries: boolean;
  };
  description?: string;
}

export interface ChatMember {
  ok: boolean;
  result?: {
    status: string;
    can_manage_topics?: boolean;
  };
  description?: string;
}

interface Update {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string; is_forum?: boolean };
    text?: string;
    from?: { id: number; username?: string };
  };
}

export async function telegramApi(
  token: string,
  method: string,
  params: object = {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return res.json();
}

export async function validateToken(token: string): Promise<BotInfo> {
  return telegramApi(token, 'getMe');
}

async function getBotChatMember(token: string, chatId: number): Promise<ChatMember> {
  const botInfo = await validateToken(token);
  return telegramApi(token, 'getChatMember', {
    chat_id: chatId,
    user_id: botInfo.result?.id,
  });
}

// eslint-disable-next-line no-unused-vars
async function getUpdates(
  token: string,
  offset: number = 0,
  timeout: number = 30
): Promise<Update[]> {
  const res = await telegramApi(token, 'getUpdates', {
    offset,
    timeout,
    allowed_updates: ['message'],
  });
  return res.ok ? (res.result ?? []) : [];
}

// ============================================================
// SPINNER
// ============================================================

export class Spinner {
  private frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  private frameIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private message: string;

  constructor(message: string) {
    this.message = message;
  }

  start() {
    write(ANSI.hideCursor);
    this.timer = setInterval(() => {
      const frame = this.frames[this.frameIndex];
      write(`\r${ANSI.clearLine}${style(frame, ANSI.cyan)} ${this.message}`);
      this.frameIndex = (this.frameIndex + 1) % this.frames.length;
    }, 80);
  }

  update(message: string) {
    this.message = message;
  }

  stop(finalMessage?: string) {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    write(`\r${ANSI.clearLine}`);
    if (finalMessage) {
      writeln(finalMessage);
    }
    write(ANSI.showCursor);
  }

  succeed(message: string) {
    this.stop(style('✓', ANSI.green, ANSI.bold) + ' ' + message);
  }

  fail(message: string) {
    this.stop(style('✗', ANSI.red, ANSI.bold) + ' ' + message);
  }

  info(message: string) {
    this.stop(style('ℹ', ANSI.blue, ANSI.bold) + ' ' + message);
  }
}

// ============================================================
// SETUP FLOW
// ============================================================

// Default project path when none is provided (null = global system config)
const DEFAULT_PROJECT_PATH = null;

/**
 * Options for the setup function
 */
export interface SetupOptions {
  /** Project path where DSR should save configuration. Default: process.cwd() */
  projectPath?: string;
  /** Pre-provided bot token (skips token prompt if valid) */
  token?: string;
}

export async function setup(options: SetupOptions = {}): Promise<void> {
  writeln();
  writeln(style('╔═══════════════════════════════════════════╗', ANSI.cyan));
  writeln(style('║   Deep Space Relay - Interactive Setup    ║', ANSI.cyan));
  writeln(style('╚═══════════════════════════════════════════╝', ANSI.cyan));
  writeln();

  // Step 1: Get bot token
  writeln(style('Step 1: Telegram Bot Token', ANSI.bold, ANSI.yellow));

  let token = options.token || '';

  // If token provided via options, validate it immediately
  if (token) {
    writeln(style('Using pre-provided bot token...', ANSI.dim));
    writeln();
  } else {
    // Check for existing token
    if (existsSync(SYSTEM_TOKEN_PATH)) {
      try {
        const existing = JSON.parse(readFileSync(SYSTEM_TOKEN_PATH, 'utf-8'));
        if (existing.token) {
          writeln(style('A bot token already exists at:', ANSI.dim));
          writeln(style(`  ${SYSTEM_TOKEN_PATH}`, ANSI.cyan));
          writeln();

          const useExisting = await confirm('Use existing token?');
          writeln();

          if (useExisting) {
            token = existing.token;
          }
        }
      } catch {
        // Ignore parse errors, just ask for new token
      }
    }

    if (!token) {
      writeln(style('Create a bot with @BotFather on Telegram to get a token.', ANSI.dim));
      writeln();
      token = await inputSecret('Enter your bot token:');
      writeln();
    }
  }

  if (!token) {
    throw new Error('No token provided');
  }

  // Step 2: Validate token
  const spinner = new Spinner('Validating bot token...');
  spinner.start();

  const botInfo = await validateToken(token);

  if (!botInfo.ok || !botInfo.result) {
    spinner.fail(`Invalid token: ${botInfo.description || 'Unknown error'}`);
    throw new Error(`Invalid token: ${botInfo.description || 'Unknown error'}`);
  }

  spinner.succeed(`Bot verified: @${botInfo.result.username} (${botInfo.result.first_name})`);
  writeln();

  // Step 3: Instructions for group setup
  writeln(style('Step 2: Set Up Your Telegram Group', ANSI.bold, ANSI.yellow));
  writeln();
  writeln(style('Please do the following:', ANSI.white));
  writeln(
    style('  1.', ANSI.green) +
      ' Create a Telegram group (you must include the bot as a member during creation)'
  );
  writeln(style('  2.', ANSI.green) + ' Enable "Topics" in group settings (Group → Edit → Topics)');
  writeln(style('  3.', ANSI.green) + ` Ensure @${botInfo.result.username} is in the group`);
  writeln(style('  4.', ANSI.green) + ' Make the bot an admin with "Manage Topics" permission');
  writeln();
  writeln(style('To get your chat ID:', ANSI.white));
  writeln(style('  1. Open the group in Telegram Web (web.telegram.org/a/)', ANSI.dim));
  writeln(style('  2. Look at the URL: web.telegram.org/a/#-1001234567890', ANSI.dim));
  writeln(style('  3. Copy the number after # (include the minus sign!)', ANSI.dim));
  writeln();

  const chatIdRaw = await input('Paste chat ID:');
  const chatIdStr = chatIdRaw.trim();
  writeln();

  if (!chatIdStr) {
    throw new Error('No chat ID provided');
  }

  // Parse and validate chat ID
  const resolveSpinner = new Spinner('Verifying chat access...');
  resolveSpinner.start();

  const chatId = parseInt(chatIdStr, 10);
  if (isNaN(chatId)) {
    resolveSpinner.fail('Invalid chat ID. Must be a number (e.g., -1001234567890)');
    throw new Error('Invalid chat ID. Must be a number (e.g., -1001234567890)');
  }

  // Verify bot has access to this chat
  const chatInfo = await telegramApi(token, 'getChat', { chat_id: chatId });
  if (!chatInfo.ok) {
    resolveSpinner.fail(
      `Bot cannot access chat ${chatId}: ${chatInfo.description || 'Unknown error'}`
    );
    writeln(style('Make sure the bot is a member of the group.', ANSI.yellow));
    throw new Error(`Bot cannot access chat ${chatId}: ${chatInfo.description || 'Unknown error'}`);
  }

  resolveSpinner.succeed(`Chat verified: ${chatInfo.result?.title || chatId}`);
  writeln();

  // Step 5: Verify permissions
  const permSpinner = new Spinner('Checking bot permissions...');
  permSpinner.start();

  const memberInfo = await getBotChatMember(token, chatId);
  const canManageTopics = memberInfo.result?.can_manage_topics;

  if (!memberInfo.ok) {
    permSpinner.fail(`Failed to check permissions: ${memberInfo.description}`);
    writeln(style('Please make sure the bot is an admin in the group.', ANSI.yellow));
    throw new Error(`Failed to check permissions: ${memberInfo.description}`);
  }

  if (!canManageTopics) {
    permSpinner.fail('Bot does not have "Manage Topics" permission');
    writeln();
    writeln(style('Please grant the bot "Manage Topics" permission:', ANSI.yellow));
    writeln(
      style(
        '  Group → Edit → Administrators → @' + botInfo.result.username + ' → Manage Topics',
        ANSI.dim
      )
    );
    writeln();
    writeln(style('Then run setup again.', ANSI.dim));
    throw new Error('Bot does not have "Manage Topics" permission');
  }

  permSpinner.succeed('Bot has required permissions');
  writeln();

  // Step 6: Ask for project path (or use provided option)
  let basePath: string;

  if (options.projectPath) {
    basePath = options.projectPath;
    writeln(style('Step 3: Configuration Output', ANSI.bold, ANSI.yellow));
    writeln(style(`Using provided project path: ${basePath}`, ANSI.dim));
    writeln();
  } else {
    writeln(style('Step 3: Configuration Output', ANSI.bold, ANSI.yellow));
    writeln(style('Enter the project path where DSR should save configuration.', ANSI.dim));
    writeln(style(`Files will be created at: <path>/${DSR_CONFIG_SUBDIR}/`, ANSI.dim));
    writeln(style('(Leave empty for Global System Config)', ANSI.dim));
    writeln();

    const projectPath = await input('Project path:', '');
    basePath = projectPath.trim();
    writeln();
  }

  // Determine output directory
  // If basePath is empty, use system config dir (no subdirectory appending)
  // If basePath is provided, append DSR_CONFIG_SUBDIR
  const systemConfigDir = dirname(SYSTEM_TOKEN_PATH);
  const outputDir = basePath ? join(basePath, DSR_CONFIG_SUBDIR) : systemConfigDir;

  // Step 7: Write config
  const configSpinner = new Spinner('Writing configuration...');
  configSpinner.start();

  const projectConfigPath = join(outputDir, 'config.json');

  // Note: SYSTEM_TOKEN_PATH is already set to the global location
  // If writing globally, projectConfigPath will be in the same dir as token.json

  try {
    // Ensure directories exist
    mkdirSync(outputDir, { recursive: true });
    // systemTokenDir is derived from SYSTEM_TOKEN_PATH, which is likely outputDir in global mode
    // but we ensure it exists just in case
    mkdirSync(dirname(SYSTEM_TOKEN_PATH), { recursive: true });

    // Write project config (chatId)
    writeFileSync(projectConfigPath, JSON.stringify({ chatId: String(chatId) }, null, 2));

    // Write system token (shared across projects) with secure permissions
    writeFileSync(SYSTEM_TOKEN_PATH, JSON.stringify({ token }, null, 2), { mode: 0o600 });

    configSpinner.succeed('Configuration saved successfully');
  } catch (err) {
    configSpinner.fail(`Failed to write config: ${err}`);
    throw err instanceof Error ? err : new Error(String(err));
  }

  writeln();
  writeln(style('╔═══════════════════════════════════════════╗', ANSI.green));
  writeln(style('║          Setup Complete!                  ║', ANSI.green));
  writeln(style('╚═══════════════════════════════════════════╝', ANSI.green));
  writeln();
  writeln(style('Configuration files created:', ANSI.white));
  writeln(style(`  Token (system):  ${SYSTEM_TOKEN_PATH}`, ANSI.cyan));
  writeln(style(`  Config (project): ${projectConfigPath}`, ANSI.cyan));
  writeln();
}

// ============================================================
// MAIN
// ============================================================

// Only run if executed directly
if (import.meta.main) {
  setup().catch((err) => {
    write(ANSI.showCursor);
    if (err instanceof UserCancelledError) {
      writeln(style('Setup cancelled.', ANSI.yellow));
      process.exit(0);
    }
    writeln(style(`Error: ${err.message || err}`, ANSI.red));
    process.exit(1);
  });
}

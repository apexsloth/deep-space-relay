/**
 * Test Utilities for DSR Integration Tests
 *
 * Provides helpers for:
 * - Spawning the daemon process with test configuration
 * - Creating relay clients for testing
 * - Managing test isolation (unique socket paths, config files)
 */

import { spawn, type ChildProcess } from 'child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { createRelay, type Relay } from '../../src/relay/index';

export interface TestDaemon {
  process: ChildProcess;
  socketPath: string;
  configPath: string;
  statePath: string;
  telegramApiUrl: string;
  stop: () => Promise<void>;
  waitForReady: () => Promise<void>;
}

export interface TestContext {
  testDir: string;
  cleanup: () => void;
}

let testCounter = 0;

/**
 * Create an isolated test directory with unique paths
 */
export function createTestContext(): TestContext {
  const testId = `test_${Date.now()}_${testCounter++}`;
  const testDir = join('/tmp', 'dsr-tests', testId);

  mkdirSync(testDir, { recursive: true });

  return {
    testDir,
    cleanup: () => {
      try {
        rmSync(testDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

/**
 * Spawn a daemon process configured for testing
 */
export async function spawnTestDaemon(
  telegramApiUrl: string,
  testContext: TestContext,
  chatId?: string
): Promise<TestDaemon> {
  const { testDir } = testContext;

  const socketPath = join(testDir, 'ds-relay.sock');
  const configPath = join(testDir, 'config.json');
  const statePath = join(testDir, 'state.json');

  // Pre-create config with chatId and token (simulates already configured)
  // The token is used for IPC authentication in test mode
  const testConfig: { chatId?: string; token?: string } = {};
  if (chatId) {
    testConfig.chatId = chatId;
  }
  // Always include the test bot token for IPC auth
  testConfig.token = 'test-bot-token';

  writeFileSync(configPath, JSON.stringify(testConfig, null, 2));

  const daemonPath = join(__dirname, '../../src/daemon.ts');

  const daemonProcess = spawn('bun', ['run', daemonPath], {
    env: {
      ...process.env,
      DSR_TEST_MODE: '1',
      DSR_TELEGRAM_API: telegramApiUrl,
      DSR_SOCKET_PATH: socketPath,
      DSR_CONFIG_PATH: configPath,
      DSR_STATE_PATH: statePath,
      DSR_LOCK_PATH: join(testDir, 'daemon.lock'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let output = '';
  daemonProcess.stdout?.on('data', (data) => {
    output += data.toString();
    // Uncomment for debugging:
    console.log('[Daemon stdout]', data.toString());
  });
  daemonProcess.stderr?.on('data', (data) => {
    output += data.toString();
    // Uncomment for debugging:
    console.error('[Daemon stderr]', data.toString());
  });

  const daemon: TestDaemon = {
    process: daemonProcess,
    socketPath,
    configPath,
    statePath,
    telegramApiUrl,

    stop: () => {
      return new Promise((resolve) => {
        if (daemonProcess.killed) {
          resolve();
          return;
        }
        daemonProcess.on('exit', () => resolve());
        daemonProcess.kill('SIGTERM');
        // Force kill after timeout
        setTimeout(() => {
          if (!daemonProcess.killed) {
            daemonProcess.kill('SIGKILL');
          }
          resolve();
        }, 2000);
      });
    },

    waitForReady: () => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Daemon did not become ready in time'));
        }, 10000);

        const checkSocket = () => {
          if (existsSync(socketPath)) {
            clearTimeout(timeout);
            // Give it a bit more time to be fully ready
            setTimeout(resolve, 100);
          } else {
            setTimeout(checkSocket, 50);
          }
        };
        checkSocket();
      });
    },
  };

  return daemon;
}

/**
 * Create a relay client configured for testing
 */
export function createTestRelay(
  socketPath: string,
  onMessage?: (text: string, isThread: boolean, messageID?: number) => void,
  projectName: string = 'TestProject',
  chatId?: string
): Relay {
  // Try to find ipcToken in the same directory as the socket
  // In test mode, the daemon uses config.token as the IPC token
  let ipcToken: string | undefined;
  const configPath = join(dirname(socketPath), 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      // In test mode, the token field is used for IPC auth
      ipcToken = config.token || config.ipcToken;
    } catch {
      // Ignore parse errors
    }
  }

  return createRelay({
    project: projectName,
    directory: dirname(configPath), // This might still not match loadConfig's expectation but we pass ipcToken directly
    chatId, // Per-session chatId (optional)
    socketPath, // Pass the socket path directly
    ipcToken, // Pass the token we found
    log: (message, level, extra) => {
      // Uncomment for debugging:
      // console.log(`[Relay ${level}]`, message, extra);
    },
    onMessage: onMessage || (() => {}),
    onPermissionResponse: () => {},
    onStop: () => {},
  });
}

/**
 * Wait for a condition to be true (with timeout)
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number = 5000,
  errorMessage: string = 'Timeout waiting for condition',
  intervalMs: number = 50
): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(errorMessage);
}

/**
 * Sleep for a specified duration
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

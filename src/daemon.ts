/**
 * Standalone Deep Space Relay Daemon
 *
 * This is a thin wrapper around the core daemon logic for standalone execution.
 * Support environment variable overrides for all configuration.
 */

import { join } from 'node:path';
import { getSystemConfigDir, getSocketPath } from './config';
import { runDaemon } from './daemon/runner';

async function main() {
  const socketPath = getSocketPath();
  const statePath = process.env.DSR_STATE_PATH || join(getSystemConfigDir(), 'state.json');
  const projectPath = process.env.DSR_PROJECT_PATH;
  // In standalone mode, default configPath to system config dir for IPC token storage
  const configPath = process.env.DSR_CONFIG_PATH || join(getSystemConfigDir(), 'config.json');
  const testMode = process.env.DSR_TEST_MODE === '1';
  const forceMode = process.argv.includes('--force');

  // Check for --log-file argument
  const logFileIndex = process.argv.indexOf('--log-file');
  const logFile =
    logFileIndex !== -1 && process.argv[logFileIndex + 1]
      ? process.argv[logFileIndex + 1]
      : undefined;

  await runDaemon({
    socketPath,
    statePath,
    projectPath: projectPath || '',
    configPath,
    testMode,
    forceMode,
    logFile,
    telegramApiUrl: process.env.DSR_TELEGRAM_API,
  });
}

main().catch((err) => {
  console.error('[Daemon CLI] Fatal error:', err);
  process.exit(1);
});

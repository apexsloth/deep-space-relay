import { createWriteStream, type WriteStream } from 'fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LoggerConfig {
  /** Path to log file */
  logFile?: string;
  /** Suppress console output (for embedded/TUI mode) */
  silent?: boolean;
}

let fileStream: WriteStream | undefined;
let silentMode = false;

function formatLogLine(level: LogLevel, message: string, extra?: any): string {
  const timestamp = new Date().toISOString();
  const extraStr = extra ? ` ${JSON.stringify(extra)}` : '';
  return `[${timestamp}] [${level.toUpperCase()}] ${message}${extraStr}\n`;
}

function defaultConsoleHandler(message: string, level: LogLevel, extra?: any) {
  if (silentMode) return;

  const label = `[Daemon] ${message}`;
  switch (level) {
    case 'error':
      console.error(label, extra || '');
      break;
    case 'warn':
      console.warn(label, extra || '');
      break;
    default:
      console.log(label, extra || '');
  }
}

/**
 * Configure the global logger.
 * Call this once at daemon startup.
 */
export function configureLogger(config: LoggerConfig): () => void {
  silentMode = config.silent ?? false;

  if (config.logFile) {
    fileStream = createWriteStream(config.logFile, { flags: 'a' });
    fileStream.write(formatLogLine('info', `Logging to file: ${config.logFile}`));
  }

  // Return cleanup function
  return () => {
    if (fileStream) {
      fileStream.end();
      fileStream = undefined;
    }
    silentMode = false;
  };
}

/**
 * Unified logging function for the daemon.
 * All daemon code should use this instead of console.log.
 */
export function log(message: string, level: LogLevel = 'info', extra?: any) {
  // Write to file if configured
  if (fileStream) {
    fileStream.write(formatLogLine(level, message, extra));
  }

  // Console output (unless silent)
  defaultConsoleHandler(message, level, extra);
}

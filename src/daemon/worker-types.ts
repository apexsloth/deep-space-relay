import type { LogLevel } from './logger';

export interface DaemonRunOptions {
  socketPath: string;
  statePath: string;
  projectPath: string;
  configPath?: string;
  token?: string;
  chatId?: string;
  ipcToken?: string;
  telegramApiUrl?: string;
  logFile?: string;
  testMode?: boolean;
  forceMode?: boolean;
  standbyRetryMs?: number;
  onLog?: (level: LogLevel, message: string, extra?: Record<string, unknown>) => void;
  onLeader?: (reason: string) => void;
  onStandby?: (retryMs: number) => void;
  onReady?: (isLeader: boolean, socketPath: string) => void;
  onError?: (err: Error) => void;
  signal?: AbortSignal;
}

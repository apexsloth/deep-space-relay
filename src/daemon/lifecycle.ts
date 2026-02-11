import { EventEmitter } from 'node:events';
import { existsSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';
import {
  STANDBY_RETRY_MS,
  HEARTBEAT_TIMEOUT_MS,
  FORCE_SHUTDOWN_TIMEOUT_MS,
  MEDIUM_DELAY_MS,
  SHORT_DELAY_MS,
  PARSE_INT_RADIX,
  STALE_CHECK_RETRY_DELAY_MS,
} from '../constants';

export type LifecycleState = 'initializing' | 'standby' | 'leading' | 'shutting_down';
export type LeaderReason = 'startup' | 'takeover';

export interface LifecycleOptions {
  socketPath: string;
  standbyRetryMs?: number;
  heartbeatTimeoutMs?: number;
  forceShutdownTimeoutMs?: number;
  onLog?: (
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    extra?: Record<string, unknown>
  ) => void;
  signal?: AbortSignal;
  ipcToken?: string;
  /** Force takeover: request existing leader to shutdown via IPC, then become leader */
  forceMode?: boolean;
  /** Path to PID file (legacy, no longer used for force takeover) */
  pidFile?: string;
}

export interface StateChangeEvent {
  oldState: LifecycleState;
  newState: LifecycleState;
  extra?: any;
}

export class LifecycleCoordinator extends EventEmitter {
  private state: LifecycleState = 'initializing';
  private socketPath: string;
  private standbyRetryMs: number;
  private heartbeatTimeoutMs: number;
  private forceShutdownTimeoutMs: number;
  private onLog: LifecycleOptions['onLog'];
  private signal?: AbortSignal;
  private ipcToken?: string;
  private forceMode: boolean;
  private pidFile?: string;
  private standbyTimer?: Timer;
  private abortListener?: () => void;

  constructor(options: LifecycleOptions) {
    super();
    this.socketPath = options.socketPath;
    this.standbyRetryMs = options.standbyRetryMs ?? STANDBY_RETRY_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.forceShutdownTimeoutMs = options.forceShutdownTimeoutMs ?? FORCE_SHUTDOWN_TIMEOUT_MS;
    this.onLog = options.onLog;
    this.signal = options.signal;
    this.ipcToken = options.ipcToken;
    this.forceMode = options.forceMode ?? false;
    this.pidFile = options.pidFile;

    if (this.signal) {
      this.abortListener = () => {
        this.log('debug', 'Abort signal received, transitioning to shutting_down');
        this.transition('shutting_down');
      };
      this.signal.addEventListener('abort', this.abortListener);
    }
  }

  private log(
    level: 'debug' | 'info' | 'warn' | 'error',
    message: string,
    extra?: Record<string, unknown>
  ) {
    this.onLog?.(level, message, extra);
  }

  public getState(): LifecycleState {
    return this.state;
  }

  private transition(newState: LifecycleState, extra?: any) {
    if (this.state === newState) return;
    if (this.state === 'shutting_down' && newState !== 'shutting_down') return;

    const oldState = this.state;
    this.state = newState;

    if (newState === 'shutting_down') {
      if (this.standbyTimer) {
        clearTimeout(this.standbyTimer);
        this.standbyTimer = undefined;
      }
    }

    this.log('debug', `Lifecycle transition: ${oldState} -> ${newState}`, extra);
    this.emit('state_change', { oldState, newState, extra } as StateChangeEvent);

    if (newState === 'leading') {
      this.emit('become_leader', extra);
    } else if (newState === 'standby') {
      this.emit('become_standby', extra);
      this.scheduleStandbyCheck();
    }
  }

  /**
   * Start the election process
   */
  public async start(): Promise<void> {
    if (this.signal?.aborted || this.state === 'shutting_down') return;

    this.log('info', 'Starting lifecycle election');

    // Force mode: request existing leader to shutdown gracefully via IPC, then become leader
    if (this.forceMode) {
      this.log('info', 'Force mode enabled, requesting leader shutdown');
      const leaderAlive = await this.checkLeaderAlive();
      if (leaderAlive) {
        if (!this.ipcToken) {
          this.log('warn', 'No IPC token available for graceful shutdown');
        }
        const shutdownOk = await this.sendShutdownViaIpc();
        if (shutdownOk) {
          this.log('info', 'Leader acknowledged shutdown');
          await new Promise((r) => setTimeout(r, MEDIUM_DELAY_MS)); // Wait for cleanup
        } else {
          this.log('warn', 'Leader did not acknowledge shutdown');
        }
      }
      await this.cleanupSocket(true);
      this.transition('leading', { reason: 'startup', forced: true });
      return;
    }

    // TODO: TOCTOU race condition - two processes can both see no leader and both emit become_leader.
    // Consider atomic socket bind or file lock for proper leader election.
    const leaderAlive = await this.checkLeaderAlive();

    if (this.getState() === 'shutting_down' || this.signal?.aborted) return;

    if (leaderAlive) {
      this.transition('standby');
    } else {
      this.log('info', 'No leader found, attempting to become leader');
      this.emit('become_leader', { reason: 'startup' });
    }
  }

  private scheduleStandbyCheck() {
    // Early exit if not in standby or shutting down
    if (this.state !== 'standby' || this.signal?.aborted) return;

    if (this.standbyTimer) clearTimeout(this.standbyTimer);

    this.standbyTimer = setTimeout(async () => {
      // Re-check state after async boundary
      const currentState = this.state;
      if (currentState !== 'standby' || this.signal?.aborted) return;

      this.log('debug', 'Performing standby health check');
      const leaderAlive = await this.checkLeaderAlive();

      // Re-check state after another async boundary
      if (this.state !== 'standby' || this.signal?.aborted) return;

      if (!leaderAlive) {
        this.log('info', 'Leader lost, attempting takeover');
        this.emit('become_leader', { reason: 'takeover' });
      } else {
        this.scheduleStandbyCheck();
      }
    }, this.standbyRetryMs);
  }

  /**
   * If leader startup fails (e.g. EADDRINUSE), fall back to standby
   */
  public reportLeaderFailure(err: any) {
    if (this.state === 'shutting_down') return;

    if (err.code === 'EADDRINUSE') {
      this.log('warn', 'Socket address in use, falling back to standby');
      this.transition('standby', { reason: 'eaddrinuse' });
    } else {
      this.log('error', 'Failed to start leader services', { error: String(err) });
      // We don't automatically shut down here, maybe we can recover in standby
      this.transition('standby', { reason: 'error', error: String(err) });
    }
  }

  /**
   * Check if a leader is currently responding on the socket.
   * Uses double-check pattern: if first check fails but socket exists,
   * waits and retries to avoid false negatives from transient failures.
   */
  public async checkLeaderAlive(): Promise<boolean> {
    const alive = await this._checkLeaderAliveOnce();
    if (alive) return true;

    // If socket file exists but leader didn't respond, wait and retry
    const isPort = /^\d+$/.test(this.socketPath);
    if (!isPort && existsSync(this.socketPath)) {
      this.log('debug', 'Leader check failed but socket exists, retrying after delay');
      await new Promise((r) => setTimeout(r, STALE_CHECK_RETRY_DELAY_MS));
      return this._checkLeaderAliveOnce();
    }

    return false;
  }

  /**
   * Single attempt to check if leader is alive
   */
  private async _checkLeaderAliveOnce(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.socketPath) {
        resolve(false);
        return;
      }

      // Handle TCP ports
      const isPort = /^\d+$/.test(this.socketPath);
      if (!isPort && !existsSync(this.socketPath)) {
        resolve(false);
        return;
      }

      let responded = false;
      const connectOptions = isPort
        ? { port: parseInt(this.socketPath, PARSE_INT_RADIX), host: '127.0.0.1' }
        : { path: this.socketPath };

      const client = connect(connectOptions);

      const timeout = setTimeout(() => {
        if (!responded) {
          responded = true;
          client.destroy();
          this.log('debug', 'Leader check timed out');
          resolve(false);
        }
      }, this.heartbeatTimeoutMs);

      client.on('connect', () => {
        // Health check only: send ping without auth.
        // Our token will never match the old daemon's token, so sending
        // auth first would cause the old daemon to reject and destroy
        // the socket before the ping is processed.  The server allows
        // unauthenticated pings for exactly this purpose.
        client.write(JSON.stringify({ type: 'ping' }) + '\n');
      });

      let buffer = '';
      client.on('data', (data) => {
        if (responded) return;
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.includes('pong')) {
            responded = true;
            clearTimeout(timeout);
            client.destroy();
            resolve(true);
            return;
          }
        }
      });

      client.on('error', (err: NodeJS.ErrnoException) => {
        if (responded) return;
        responded = true;
        clearTimeout(timeout);
        client.destroy();
        this.log('debug', 'Leader check connection error', { code: err.code });
        resolve(false);
      });

      client.on('close', () => {
        if (!responded) {
          responded = true;
          clearTimeout(timeout);
          resolve(false);
        }
      });
    });
  }

  public cleanupSocket(force: boolean = false) {
    if (this.state !== 'leading' && !force) {
      this.log('debug', `Skipping socket cleanup: state is ${this.state} (not leading)`);
      return;
    }
    if (!/^\d+$/.test(this.socketPath) && existsSync(this.socketPath)) {
      try {
        this.log('debug', `Cleaning up socket: ${this.socketPath}`);
        unlinkSync(this.socketPath);
      } catch (err) {
        this.log('warn', 'Failed to unlink socket', { error: String(err) });
      }
    }
  }

  /**
   * Request the current leader to shutdown gracefully via IPC.
   * Returns true if shutdown was acknowledged, false otherwise.
   */
  public async requestLeaderShutdown(pidFile?: string): Promise<boolean> {
    // Try IPC shutdown
    const ipcSuccess = await this.sendShutdownViaIpc();
    if (ipcSuccess) {
      this.log('info', 'Leader acknowledged shutdown via IPC');
      // Wait a bit for process to exit
      await new Promise((r) => setTimeout(r, SHORT_DELAY_MS));
      return true;
    }

    // No forceful shutdown - respect existing leader
    this.log('debug', 'Leader did not acknowledge IPC shutdown, respecting existing leader');
    return false;
  }

  private async sendShutdownViaIpc(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.socketPath) {
        resolve(false);
        return;
      }

      const isPort = /^\d+$/.test(this.socketPath);
      if (!isPort && !existsSync(this.socketPath)) {
        resolve(false);
        return;
      }

      let responded = false;
      const connectOptions = isPort
        ? { port: parseInt(this.socketPath, PARSE_INT_RADIX), host: '127.0.0.1' }
        : { path: this.socketPath };

      const client = connect(connectOptions);

      const timeout = setTimeout(() => {
        if (!responded) {
          responded = true;
          client.destroy();
          this.log('debug', 'Shutdown request timed out');
          resolve(false);
        }
      }, this.forceShutdownTimeoutMs);

      client.on('connect', () => {
        if (this.ipcToken) {
          client.write(JSON.stringify({ type: 'auth', token: this.ipcToken }) + '\n');
        }
        client.write(JSON.stringify({ type: 'shutdown', reason: 'force_takeover' }) + '\n');
      });

      let buffer = '';
      client.on('data', (data) => {
        if (responded) return;
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.includes('shutdown_ack')) {
            responded = true;
            clearTimeout(timeout);
            client.destroy();
            resolve(true);
            return;
          }
        }
      });

      client.on('error', (err: NodeJS.ErrnoException) => {
        if (responded) return;
        responded = true;
        clearTimeout(timeout);
        client.destroy();
        this.log('debug', 'Shutdown IPC connection error', { code: err.code });
        resolve(false);
      });

      client.on('close', () => {
        if (!responded) {
          responded = true;
          clearTimeout(timeout);
          resolve(false);
        }
      });
    });
  }

  public confirmLeading(extra?: any) {
    if (this.state === 'shutting_down') return;
    this.transition('leading', extra);
  }

  public async stop(): Promise<void> {
    if (this.standbyTimer) {
      clearTimeout(this.standbyTimer);
      this.standbyTimer = undefined;
    }
    if (this.signal && this.abortListener) {
      this.signal.removeEventListener('abort', this.abortListener);
      this.abortListener = undefined;
    }
    this.transition('shutting_down');
  }
}

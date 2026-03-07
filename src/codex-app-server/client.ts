import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { LogFn } from '../types';
import type {
  CodexAppServerSpawnConfig,
  CodexInitializeParams,
  CodexThreadResult,
  CodexThreadResumeParams,
  CodexThreadStartParams,
  CodexTurnInterruptParams,
  CodexTurnResult,
  CodexTurnStartParams,
  CodexTurnSteerParams,
  CodexTurnSteerResult,
  JsonRpcError,
  JsonRpcErrorResponse,
  JsonRpcMessage,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcSuccessResponse,
} from './types';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return 'method' in message && 'id' in message;
}

function isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
  return 'method' in message && !('id' in message);
}

function isErrorResponse(message: JsonRpcMessage): message is JsonRpcErrorResponse {
  return 'error' in message;
}

function jsonRpcErrorToError(error: JsonRpcError): Error {
  const err = new Error(error.message);
  (err as Error & { code?: number; data?: unknown }).code = error.code;
  (err as Error & { code?: number; data?: unknown }).data = error.data;
  return err;
}

class JsonlRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<(message: JsonRpcNotification) => void>();
  private requestHandler?: (message: JsonRpcRequest) => Promise<unknown>;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly log: LogFn
  ) {
    const rl = createInterface({ input });
    rl.on('line', (line) => {
      void this.handleLine(line);
    });
    input.on('error', (error) => {
      this.failPending(new Error(`JSON-RPC input failed: ${String(error)}`));
    });
  }

  public onNotification(handler: (message: JsonRpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  public setRequestHandler(handler: (message: JsonRpcRequest) => Promise<unknown>): void {
    this.requestHandler = handler;
  }

  public async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    const id = this.nextId++;
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };

    return await new Promise<TResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(payload);
    });
  }

  public notify(method: string, params?: unknown): void {
    const payload: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params === undefined ? {} : { params }),
    };
    this.write(payload);
  }

  public close(): void {
    this.failPending(new Error('JSON-RPC connection closed'));
  }

  private write(payload: JsonRpcRequest | JsonRpcNotification | JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    this.output.write(JSON.stringify(payload) + '\n');
  }

  private failPending(error: Error): void {
    for (const [, pending] of this.pending) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }

    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch (error) {
      this.log('Failed to parse JSON-RPC line', 'warn', { line, error: String(error) });
      return;
    }

    if (isNotification(message)) {
      for (const handler of this.notificationHandlers) {
        handler(message);
      }
      return;
    }

    if (isRequest(message)) {
      await this.handleServerRequest(message);
      return;
    }

    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!pending) {
      this.log('Received JSON-RPC response for unknown request', 'debug', { message });
      return;
    }

    this.pending.delete(message.id);
    if (isErrorResponse(message)) {
      pending.reject(jsonRpcErrorToError(message.error));
      return;
    }

    pending.resolve(message.result);
  }

  private async handleServerRequest(message: JsonRpcRequest): Promise<void> {
    if (!this.requestHandler) {
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `Unhandled server request: ${message.method}`,
        },
      });
      return;
    }

    try {
      const result = await this.requestHandler(message);
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        result,
      });
    } catch (error) {
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
}

export class CodexAppServerClient {
  private readonly rpcPeer: JsonlRpcPeer;
  private readonly notificationHandlers = new Set<(message: JsonRpcNotification) => void>();
  private initialized = false;

  constructor(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
    private readonly log: LogFn,
    private readonly childProcess?: ChildProcessWithoutNullStreams
  ) {
    this.rpcPeer = new JsonlRpcPeer(input, output, log);
    this.rpcPeer.onNotification((message) => {
      for (const handler of this.notificationHandlers) {
        handler(message);
      }
    });
  }

  public static spawn(config: CodexAppServerSpawnConfig, log: LogFn): CodexAppServerClient {
    const command = config.command || 'codex';
    const args = config.args || ['app-server'];
    const child = spawn(command, args, {
      cwd: config.cwd,
      env: {
        ...process.env,
        ...(config.env || {}),
      },
      stdio: 'pipe',
    });

    const stderr = createInterface({ input: child.stderr });
    stderr.on('line', (line) => {
      log('codex app-server stderr', 'debug', { line });
    });

    return new CodexAppServerClient(child.stdout, child.stdin, log, child);
  }

  public onNotification(handler: (message: JsonRpcNotification) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  public setRequestHandler(handler: (message: JsonRpcRequest) => Promise<unknown>): void {
    this.rpcPeer.setRequestHandler(handler);
  }

  public async initialize<TResult = unknown>(params: CodexInitializeParams): Promise<TResult> {
    if (this.initialized) {
      throw new Error('Codex app-server client already initialized');
    }

    const result = await this.rpcPeer.request<TResult>('initialize', params);
    this.rpcPeer.notify('initialized', {});
    this.initialized = true;
    return result;
  }

  public async threadStart<TResult extends CodexThreadResult = CodexThreadResult>(
    params: CodexThreadStartParams
  ): Promise<TResult> {
    return await this.rpcPeer.request<TResult>('thread/start', params);
  }

  public async threadResume<TResult extends CodexThreadResult = CodexThreadResult>(
    params: CodexThreadResumeParams
  ): Promise<TResult> {
    return await this.rpcPeer.request<TResult>('thread/resume', params);
  }

  public async turnStart<TResult extends CodexTurnResult = CodexTurnResult>(
    params: CodexTurnStartParams
  ): Promise<TResult> {
    return await this.rpcPeer.request<TResult>('turn/start', params);
  }

  public async turnSteer<TResult extends CodexTurnSteerResult = CodexTurnSteerResult>(
    params: CodexTurnSteerParams
  ): Promise<TResult> {
    return await this.rpcPeer.request<TResult>('turn/steer', params);
  }

  public async turnInterrupt<TResult = {}>(params: CodexTurnInterruptParams): Promise<TResult> {
    return await this.rpcPeer.request<TResult>('turn/interrupt', params);
  }

  public async request<TResult>(method: string, params?: unknown): Promise<TResult> {
    return await this.rpcPeer.request<TResult>(method, params);
  }

  public notify(method: string, params?: unknown): void {
    this.rpcPeer.notify(method, params);
  }

  public async close(): Promise<void> {
    this.rpcPeer.close();
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill('SIGTERM');
    }
  }
}

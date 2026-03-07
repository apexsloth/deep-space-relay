import { describe, it, expect, mock } from 'bun:test';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { CodexAppServerClient } from '../src/codex-app-server/client';
import { CodexSessionManager } from '../src/codex-app-server/session-manager';
import type { JsonRpcNotification, JsonRpcRequest } from '../src/codex-app-server/types';

function createLog() {
  return mock(() => {});
}

function createLineQueue(rl: ReturnType<typeof createInterface>) {
  const buffered: Record<string, unknown>[] = [];
  const waiters: Array<(value: Record<string, unknown>) => void> = [];

  rl.on('line', (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(message);
      return;
    }
    buffered.push(message);
  });

  return {
    next(): Promise<Record<string, unknown>> {
      const message = buffered.shift();
      if (message) {
        return Promise.resolve(message);
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

describe('CodexAppServerClient', () => {
  it('should perform initialize followed by initialized notification', async () => {
    const serverToClient = new PassThrough();
    const clientToServer = new PassThrough();
    const outbound = createLineQueue(createInterface({ input: clientToServer }));
    const client = new CodexAppServerClient(serverToClient, clientToServer, createLog());

    const initializePromise = client.initialize({
      clientInfo: {
        name: 'deep-space-relay',
        title: 'Deep Space Relay',
        version: '0.0.0-test',
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    const initializeRequest = await outbound.next();
    expect(initializeRequest.method).toBe('initialize');
    expect(initializeRequest.params).toEqual({
      clientInfo: {
        name: 'deep-space-relay',
        title: 'Deep Space Relay',
        version: '0.0.0-test',
      },
      capabilities: {
        experimentalApi: true,
      },
    });

    const initializedNotificationPromise = outbound.next();
    serverToClient.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: initializeRequest.id,
        result: {
          serverInfo: { name: 'codex-app-server', version: 'test' },
        },
      }) + '\n'
    );

    await expect(initializePromise).resolves.toEqual({
      serverInfo: { name: 'codex-app-server', version: 'test' },
    });

    const initializedNotification = await initializedNotificationPromise;
    expect(initializedNotification.method).toBe('initialized');
    expect(initializedNotification.params).toEqual({});
  });

  it('should answer server-initiated requests through the registered handler', async () => {
    const serverToClient = new PassThrough();
    const clientToServer = new PassThrough();
    const outbound = createLineQueue(createInterface({ input: clientToServer }));
    const client = new CodexAppServerClient(serverToClient, clientToServer, createLog());

    client.setRequestHandler(async (message: JsonRpcRequest) => {
      expect(message.method).toBe('item/tool/call');
      return {
        contentItems: [{ type: 'text', text: 'sent' }],
      };
    });

    serverToClient.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 77,
        method: 'item/tool/call',
        params: {
          toolName: 'dsr_send',
        },
      }) + '\n'
    );

    const response = await outbound.next();
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 77,
      result: {
        contentItems: [{ type: 'text', text: 'sent' }],
      },
    });
  });
});

describe('CodexSessionManager', () => {
  it('should create a thread, start turns, steer active turns, and clear state on completion', async () => {
    let notificationHandler: ((message: JsonRpcNotification) => void) | undefined;
    const client = {
      initialize: mock(async () => undefined),
      onNotification: mock((handler: (message: JsonRpcNotification) => void) => {
        notificationHandler = handler;
        return () => {
          notificationHandler = undefined;
        };
      }),
      threadStart: mock(async () => ({
        thread: { id: 'thr_001' },
      })),
      threadResume: mock(async () => ({
        thread: { id: 'thr_resume' },
      })),
      turnStart: mock(async () => ({
        turn: { id: 'turn_001', threadId: 'thr_001' },
      })),
      turnSteer: mock(async () => ({
        turnId: 'turn_001',
      })),
      turnInterrupt: mock(async () => ({})),
    };

    const manager = new CodexSessionManager(client as never, createLog());

    const firstState = await manager.injectMessage('ses_001', 'hello from telegram', {
      registration: {
        cwd: '/repo',
        title: 'DSR Session',
        threadConfig: {
          cwd: '/repo',
        },
      },
    });
    expect(client.threadStart).toHaveBeenCalledWith({
      cwd: '/repo',
    });
    expect(client.turnStart).toHaveBeenCalledWith({
      threadId: 'thr_001',
      input: [{ type: 'text', text: 'hello from telegram' }],
    });
    expect(firstState).toEqual({
      localSessionId: 'ses_001',
      threadId: 'thr_001',
      activeTurnId: 'turn_001',
      status: 'busy',
      cwd: '/repo',
      title: 'DSR Session',
    });

    const secondState = await manager.injectMessage('ses_001', 'follow-up');
    expect(client.turnSteer).toHaveBeenCalledWith({
      threadId: 'thr_001',
      input: [{ type: 'text', text: 'follow-up' }],
      expectedTurnId: 'turn_001',
    });
    expect(secondState.activeTurnId).toBe('turn_001');
    expect(secondState.status).toBe('busy');

    notificationHandler?.({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn_001',
          threadId: 'thr_001',
        },
      },
    });

    expect(manager.getSession('ses_001')).toEqual({
      localSessionId: 'ses_001',
      threadId: 'thr_001',
      status: 'idle',
      cwd: '/repo',
      title: 'DSR Session',
    });

    await manager.interrupt('ses_001');
    expect(client.turnInterrupt).not.toHaveBeenCalled();

    await manager.injectMessage('ses_001', 'new turn');
    await manager.interrupt('ses_001');
    expect(client.turnInterrupt).toHaveBeenCalledWith({
      threadId: 'thr_001',
      turnId: 'turn_001',
    });
  });

  it('should resume an existing thread when one is provided', async () => {
    const client = {
      initialize: mock(async () => undefined),
      onNotification: mock(() => () => {}),
      threadStart: mock(async () => ({
        thread: { id: 'thr_new' },
      })),
      threadResume: mock(async () => ({
        thread: { id: 'thr_existing' },
      })),
      turnStart: mock(async () => ({
        turn: { id: 'turn_existing', threadId: 'thr_existing' },
      })),
      turnSteer: mock(async () => ({
        turnId: 'turn_existing',
      })),
      turnInterrupt: mock(async () => ({})),
    };

    const manager = new CodexSessionManager(client as never, createLog());
    const state = await manager.registerSession({
      localSessionId: 'ses_resume',
      threadId: 'thr_existing',
      threadConfig: {
        model: 'gpt-5-codex',
      },
    });

    expect(client.threadResume).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      model: 'gpt-5-codex',
    });
    expect(state).toEqual({
      localSessionId: 'ses_resume',
      threadId: 'thr_existing',
      status: 'idle',
      cwd: undefined,
      title: undefined,
    });
  });
});

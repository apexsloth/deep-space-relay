import { afterEach, describe, expect, it } from 'bun:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CodexAppServerClient } from '../src/codex-app-server/client';
import { CodexSessionManager } from '../src/codex-app-server/session-manager';
import type { LogFn } from '../src/types';

const testsDir = dirname(fileURLToPath(import.meta.url));
const mockServerPath = join(testsDir, 'mocks', 'codex-app-server-stdio-mock.ts');

const noopLog: LogFn = () => {};

const activeClients = new Set<CodexAppServerClient>();

function createClient(): CodexAppServerClient {
  const client = CodexAppServerClient.spawn(
    {
      command: 'bun',
      args: ['run', mockServerPath],
    },
    noopLog
  );
  activeClients.add(client);
  return client;
}

afterEach(async () => {
  await Promise.all([...activeClients].map((client) => client.close()));
  activeClients.clear();
});

describe('CodexAppServerClient', () => {
  it('handles initialize and thread/turn requests over stdio JSON-RPC', async () => {
    const client = createClient();

    const initialized = await client.initialize<{
      protocolVersion: string;
      serverInfo: { name: string };
    }>({
      clientInfo: { name: 'dsr-test', title: 'DSR Test', version: '0.0.1' },
    });
    const thread = await client.threadStart<{
      thread: { id: string; status: { type: string } };
      echoedParams: unknown;
    }>({
      cwd: '/tmp/repo',
    });
    const turn = await client.turnStart<{
      turn: { id: string; threadId: string; status: string };
      echoedParams: unknown;
    }>({
      threadId: thread.thread.id,
      input: [{ type: 'text', text: 'hello from telegram' }],
    });

    expect(initialized.protocolVersion).toBe('2026-03-01');
    expect(initialized.serverInfo.name).toBe('mock-codex-app-server');
    expect(thread.thread.id).toBe('thr_mock_1');
    expect(thread.echoedParams).toEqual({ cwd: '/tmp/repo' });
    expect(turn.turn.id).toBe('turn_mock_1');
    expect(turn.echoedParams).toEqual({
      threadId: 'thr_mock_1',
      input: [{ type: 'text', text: 'hello from telegram' }],
    });
  });

  it('emits server notifications', async () => {
    const client = createClient();
    const notifications: Array<{ method: string; params: unknown }> = [];

    const unsubscribe = client.onNotification((message) => {
      notifications.push({ method: message.method, params: message.params });
    });

    await client.request('send_notification', {
      method: 'item/updated',
      params: { value: 42 },
    });

    unsubscribe();

    expect(notifications).toEqual([
      {
        method: 'item/updated',
        params: { value: 42 },
      },
    ]);
  });

  it('responds to server-initiated requests', async () => {
    const client = createClient();
    client.setRequestHandler(async (message) => {
      expect(message.method).toBe('item/tool/call');
      const params = message.params as { toolName?: string };
      return {
        contentItems: [
          {
            type: 'output_text',
            text: `handled ${params.toolName || 'unknown'}`,
          },
        ],
      };
    });

    const result = await client.request<{
      clientResult: {
        contentItems: Array<{ type: string; text: string }>;
      };
      clientError: unknown;
    }>('trigger_request', {
      method: 'item/tool/call',
      params: { toolName: 'dsr_send' },
    });

    expect(result.clientError).toBeNull();
    expect(result.clientResult).toEqual({
      contentItems: [
        {
          type: 'output_text',
          text: 'handled dsr_send',
        },
      ],
    });
  });

  it('tracks thread ownership and turn lifecycle for DSR-owned sessions', async () => {
    const client = createClient();
    const manager = new CodexSessionManager(client, noopLog);

    await manager.initialize({
      clientInfo: { name: 'dsr-test', title: 'DSR Test', version: '0.0.1' },
    });

    const registered = await manager.registerSession({
      localSessionId: 'ses_local_1',
      cwd: '/tmp/repo',
      title: 'Test Session',
    });
    expect(registered.threadId).toBe('thr_mock_1');
    expect(registered.status).toBe('idle');

    const busy = await manager.injectMessage('ses_local_1', 'hello from telegram');
    expect(busy.activeTurnId).toBe('turn_mock_1');
    expect(busy.status).toBe('busy');

    await client.request('send_notification', {
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn_mock_1',
          threadId: 'thr_mock_1',
          status: 'completed',
        },
      },
    });

    const idle = manager.getSession('ses_local_1');
    expect(idle?.activeTurnId).toBeUndefined();
    expect(idle?.status).toBe('idle');
  });
});

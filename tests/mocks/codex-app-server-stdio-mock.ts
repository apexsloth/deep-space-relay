type JsonRpcId = string | number;

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

let buffer = '';
let pendingClientRequestId: JsonRpcId | null = null;
let pendingCallerId: JsonRpcId | null = null;
let activeThreadId = 'thr_mock_1';
let activeTurnId = 'turn_mock_1';

function send(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: JsonRpcId, result: unknown): void {
  send({
    jsonrpc: '2.0',
    id,
    result,
  });
}

function sendError(id: JsonRpcId, message: string): void {
  send({
    jsonrpc: '2.0',
    id,
    error: {
      code: -32000,
      message,
    },
  });
}

async function handleMessage(message: JsonRpcMessage): Promise<void> {
  if (message.method && message.id !== undefined) {
    switch (message.method) {
      case 'initialize':
        sendResult(message.id, {
          protocolVersion: '2026-03-01',
          serverInfo: {
            name: 'mock-codex-app-server',
          },
        });
        return;
      case 'thread/start':
        sendResult(message.id, {
          thread: {
            id: activeThreadId,
            status: { type: 'loaded' },
          },
          echoedParams: message.params || null,
        });
        return;
      case 'thread/resume': {
        const params = (message.params || {}) as { threadId?: string };
        sendResult(message.id, {
          thread: {
            id: params.threadId || activeThreadId,
            status: { type: 'loaded' },
          },
          echoedParams: message.params || null,
        });
        return;
      }
      case 'turn/start':
        activeTurnId = 'turn_mock_1';
        sendResult(message.id, {
          turn: {
            id: activeTurnId,
            threadId: activeThreadId,
            status: 'inProgress',
          },
          echoedParams: message.params || null,
        });
        send({
          jsonrpc: '2.0',
          method: 'turn/started',
          params: {
            turn: {
              id: activeTurnId,
              threadId: activeThreadId,
              status: 'inProgress',
            },
          },
        });
        return;
      case 'turn/steer':
        sendResult(message.id, {
          turnId: activeTurnId,
          echoedParams: message.params || null,
        });
        return;
      case 'turn/interrupt':
        sendResult(message.id, {});
        send({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: {
            turn: {
              id: activeTurnId,
              threadId: activeThreadId,
              status: 'completed',
            },
          },
        });
        return;
      case 'send_notification': {
        const params = (message.params || {}) as { method?: string; params?: unknown };
        send({
          jsonrpc: '2.0',
          method: params.method || 'item/updated',
          params: params.params || {},
        });
        sendResult(message.id, { ok: true });
        return;
      }
      case 'trigger_request': {
        const params = (message.params || {}) as { method?: string; params?: unknown };
        pendingClientRequestId = 'server-request-1';
        pendingCallerId = message.id;
        send({
          jsonrpc: '2.0',
          id: pendingClientRequestId,
          method: params.method || 'item/tool/call',
          params: params.params || {},
        });
        return;
      }
      default:
        sendError(message.id, `Unknown method: ${message.method}`);
        return;
    }
  }

  if (message.id !== undefined && pendingClientRequestId !== null && message.id === pendingClientRequestId) {
    const callerId = pendingCallerId;
    pendingClientRequestId = null;
    pendingCallerId = null;
    if (callerId !== null) {
      sendResult(callerId, {
        clientResult: message.result,
        clientError: message.error || null,
      });
    }
  }
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk: string | Buffer) => {
  buffer += String(chunk);

  let newlineIndex = buffer.indexOf('\n');
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);

    if (line) {
      const message = JSON.parse(line) as JsonRpcMessage;
      await handleMessage(message);
    }

    newlineIndex = buffer.indexOf('\n');
  }
});

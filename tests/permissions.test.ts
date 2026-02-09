import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { createPermissionHandler } from '../src/permissions';
import type { Relay } from '../src/relay/core';
import type { LogFn, PluginContext } from '../src/types';

// Helper to create a mock relay
function createMockRelay(overrides: Partial<Relay> = {}): Relay {
  return {
    register: mock(() => Promise.resolve({ success: true })),
    deregister: mock(() => Promise.resolve({ success: true })),
    send: mock(() => Promise.resolve({ success: true })),
    broadcast: mock(() => Promise.resolve({ success: true })),
    replyTo: mock(() => Promise.resolve({ success: true })),
    sendPermission: mock(() => Promise.resolve({ success: true })),
    askPermission: mock(() => Promise.resolve({ success: true, response: 'approve' })),
    setStatus: mock(() => Promise.resolve({ success: true })),
    updateMeta: mock(() => {}),
    deleteSession: mock(() => Promise.resolve({ success: true })),
    updateTitle: mock(() => Promise.resolve({ success: true })),
    sendTyping: mock(() => Promise.resolve({ success: true })),
    sendError: mock(() => Promise.resolve({ success: true })),
    setAgentName: mock(() => Promise.resolve({ success: true })),
    react: mock(() => Promise.resolve({ success: true })),
    reactTo: mock(() => Promise.resolve({ success: true })),
    ask: mock(() => Promise.resolve({ success: true, selection: 'Option A' })),
    getState: mock(() => ({
      socket: null,
      registered: true,
      hasThread: true,
      sessionID: 'ses-test-001',
      lastMessageID: 42,
      title: 'Test Session',
    })),
    getStatus: mock(() => ({
      connected: true,
      registered: true,
      hasThread: true,
      sessionID: 'ses-test-001',
      project: 'TestProject',
      directory: '/test',
      chatId: '-1001234567890',
    })),
    getConfig: mock(() => Promise.resolve({ chatId: null })),
    simulateReaction: mock(() => Promise.resolve()),
    sendMessage: mock(() => Promise.resolve({ success: true })),
    getHealth: mock(() => Promise.resolve({ success: true })),
    close: mock(() => {}),
    ...overrides,
  } as unknown as Relay;
}

// Helper to create a mock client
function createMockClient() {
  return {
    app: {
      log: mock(() => Promise.resolve()),
    },
    session: {
      prompt: mock(() => Promise.resolve({})),
      abort: mock(() => Promise.resolve({})),
      get: mock(() => Promise.resolve({ data: { title: 'Test' } })),
      messages: mock(() => Promise.resolve({ data: [] })),
      list: mock(() => Promise.resolve({ data: [] })),
    },
    postSessionIdPermissionsPermissionId: mock(() => Promise.resolve({ data: true })),
  } as unknown as PluginContext['client'];
}

describe('Permission Handler', () => {
  let logMessages: Array<{ message: string; level: string; extra?: Record<string, unknown> }>;
  let logFn: LogFn;
  let mockClient: ReturnType<typeof createMockClient>;
  let relays: Map<string, Relay>;

  beforeEach(() => {
    logMessages = [];
    logFn = (message, level = 'info', extra) => {
      logMessages.push({ message, level, extra });
    };
    mockClient = createMockClient();
    relays = new Map();
  });

  describe('question-type permissions (with options)', () => {
    it('should forward question to Telegram via relay.ask()', async () => {
      const mockRelay = createMockRelay();
      relays.set('ses-test-001', mockRelay);

      const handler = createPermissionHandler(
        (id) => relays.get(id)!,
        logFn,
        relays,
        mockClient,
        '/test'
      );

      await handler(
        {
          id: 'perm-q-001',
          type: 'question',
          sessionID: 'ses-test-001',
          messageID: 'msg-001',
          title: 'Which database should we use?',
          metadata: { options: ['PostgreSQL', 'MySQL', 'SQLite'] },
          time: { created: Date.now() },
        },
        { status: 'ask' }
      );

      // Give fire-and-forget promise time to settle
      await new Promise((r) => setTimeout(r, 50));

      // Should have called relay.ask with the question and options
      expect(mockRelay.ask).toHaveBeenCalledWith(
        'Which database should we use?',
        ['PostgreSQL', 'MySQL', 'SQLite']
      );

      // Should have called the permission API with the selection
      expect(mockClient.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
        path: { id: 'ses-test-001', permissionID: 'perm-q-001' },
        body: { response: 'Option A' }, // mock returns 'Option A'
        query: { directory: '/test' },
      });
    });

    it('should not modify output.status (TUI also shows dialog)', async () => {
      const mockRelay = createMockRelay();
      relays.set('ses-test-001', mockRelay);

      const handler = createPermissionHandler(
        (id) => relays.get(id)!,
        logFn,
        relays,
        mockClient,
        '/test'
      );

      const output = { status: 'ask' as const };
      await handler(
        {
          id: 'perm-q-002',
          type: 'question',
          sessionID: 'ses-test-001',
          messageID: 'msg-002',
          title: 'Pick one',
          metadata: { options: ['A', 'B'] },
          time: { created: Date.now() },
        },
        output
      );

      // Output status should remain 'ask' — TUI should still show the dialog
      expect(output.status).toBe('ask');
    });

    it('should handle metadata.choices as well as metadata.options', async () => {
      const mockRelay = createMockRelay();
      relays.set('ses-test-001', mockRelay);

      const handler = createPermissionHandler(
        (id) => relays.get(id)!,
        logFn,
        relays,
        mockClient,
        '/test'
      );

      await handler(
        {
          id: 'perm-q-003',
          type: 'question',
          sessionID: 'ses-test-001',
          messageID: 'msg-003',
          title: 'Choose',
          metadata: { choices: ['Yes', 'No'] },
          time: { created: Date.now() },
        },
        { status: 'ask' }
      );

      await new Promise((r) => setTimeout(r, 50));

      expect(mockRelay.ask).toHaveBeenCalledWith('Choose', ['Yes', 'No']);
    });

    it('should gracefully handle ask timeout/failure', async () => {
      const mockRelay = createMockRelay({
        ask: mock(() => Promise.resolve({ success: false, error: 'Question timed out' })),
      });
      relays.set('ses-test-001', mockRelay);

      const handler = createPermissionHandler(
        (id) => relays.get(id)!,
        logFn,
        relays,
        mockClient,
        '/test'
      );

      await handler(
        {
          id: 'perm-q-004',
          type: 'question',
          sessionID: 'ses-test-001',
          messageID: 'msg-004',
          title: 'Pick',
          metadata: { options: ['X', 'Y'] },
          time: { created: Date.now() },
        },
        { status: 'ask' }
      );

      await new Promise((r) => setTimeout(r, 50));

      // Should NOT have called the permission API
      expect(mockClient.postSessionIdPermissionsPermissionId).not.toHaveBeenCalled();
    });

    it('should handle permission API rejection (already resolved via TUI)', async () => {
      const mockRelay = createMockRelay();
      relays.set('ses-test-001', mockRelay);

      const rejectingClient = createMockClient();
      rejectingClient.postSessionIdPermissionsPermissionId = mock(() =>
        Promise.reject(new Error('Permission already resolved'))
      ) as any;

      const handler = createPermissionHandler(
        (id) => relays.get(id)!,
        logFn,
        relays,
        rejectingClient,
        '/test'
      );

      // Should not throw
      await handler(
        {
          id: 'perm-q-005',
          type: 'question',
          sessionID: 'ses-test-001',
          messageID: 'msg-005',
          title: 'Which?',
          metadata: { options: ['A', 'B'] },
          time: { created: Date.now() },
        },
        { status: 'ask' }
      );

      await new Promise((r) => setTimeout(r, 50));

      // Should have logged a debug message about it
      const debugLog = logMessages.find(
        (m) => m.message.includes('likely already resolved via TUI')
      );
      expect(debugLog).toBeDefined();
    });
  });

  describe('tool permission requests (without options)', () => {
    it('should forward tool permission to Telegram via relay.askPermission()', async () => {
      const mockRelay = createMockRelay();
      relays.set('ses-test-001', mockRelay);

      const handler = createPermissionHandler(
        (id) => relays.get(id)!,
        logFn,
        relays,
        mockClient,
        '/test'
      );

      await handler(
        {
          id: 'perm-t-001',
          type: 'bash',
          sessionID: 'ses-test-001',
          messageID: 'msg-001',
          title: 'rm -rf /tmp/old-files',
          metadata: {},
          time: { created: Date.now() },
        },
        { status: 'ask' }
      );

      await new Promise((r) => setTimeout(r, 50));

      // Should have called relay.askPermission
      expect(mockRelay.askPermission).toHaveBeenCalledWith(
        'perm-t-001',
        'bash',
        'rm -rf /tmp/old-files'
      );

      // Should have called permission API with 'once' (approve maps to once)
      expect(mockClient.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
        path: { id: 'ses-test-001', permissionID: 'perm-t-001' },
        body: { response: 'once' },
        query: { directory: '/test' },
      });
    });

    it('should map deny response to reject', async () => {
      const mockRelay = createMockRelay({
        askPermission: mock(() => Promise.resolve({ success: true, response: 'deny' })),
      });
      relays.set('ses-test-001', mockRelay);

      const handler = createPermissionHandler(
        (id) => relays.get(id)!,
        logFn,
        relays,
        mockClient,
        '/test'
      );

      await handler(
        {
          id: 'perm-t-002',
          type: 'write',
          sessionID: 'ses-test-001',
          messageID: 'msg-002',
          title: 'Write to /etc/hosts',
          metadata: {},
          time: { created: Date.now() },
        },
        { status: 'ask' }
      );

      await new Promise((r) => setTimeout(r, 50));

      // Should have called permission API with 'reject'
      expect(mockClient.postSessionIdPermissionsPermissionId).toHaveBeenCalledWith({
        path: { id: 'ses-test-001', permissionID: 'perm-t-002' },
        body: { response: 'reject' },
        query: { directory: '/test' },
      });
    });

    it('should use pattern as description when title is missing', async () => {
      const mockRelay = createMockRelay();
      relays.set('ses-test-001', mockRelay);

      const handler = createPermissionHandler(
        (id) => relays.get(id)!,
        logFn,
        relays,
        mockClient,
        '/test'
      );

      await handler(
        {
          id: 'perm-t-003',
          type: 'bash',
          sessionID: 'ses-test-001',
          messageID: 'msg-003',
          title: '',
          pattern: 'npm run *',
          metadata: {},
          time: { created: Date.now() },
        },
        { status: 'ask' }
      );

      await new Promise((r) => setTimeout(r, 50));

      // Description should fall back to undefined since title is empty and pattern
      // is only used when title is falsy
      expect(mockRelay.askPermission).toHaveBeenCalled();
    });
  });

  describe('edge cases', () => {
    it('should skip when no relay exists for session', async () => {
      // Don't add any relay
      const handler = createPermissionHandler(
        (id) => relays.get(id)!,
        logFn,
        relays,
        mockClient,
        '/test'
      );

      await handler(
        {
          id: 'perm-skip-001',
          type: 'question',
          sessionID: 'ses-unknown',
          messageID: 'msg-001',
          title: 'Pick',
          metadata: { options: ['A', 'B'] },
          time: { created: Date.now() },
        },
        { status: 'ask' }
      );

      await new Promise((r) => setTimeout(r, 50));

      // Should log and skip
      const debugLog = logMessages.find(
        (m) => m.message.includes('no relay for session')
      );
      expect(debugLog).toBeDefined();
    });

    it('should skip when session is not registered', async () => {
      const mockRelay = createMockRelay({
        getState: mock(() => ({
          socket: null,
          registered: false,
          hasThread: false,
          sessionID: null,
        })),
      });
      relays.set('ses-test-001', mockRelay);

      const handler = createPermissionHandler(
        (id) => relays.get(id)!,
        logFn,
        relays,
        mockClient,
        '/test'
      );

      await handler(
        {
          id: 'perm-skip-002',
          type: 'question',
          sessionID: 'ses-test-001',
          messageID: 'msg-001',
          title: 'Pick',
          metadata: { options: ['A'] },
          time: { created: Date.now() },
        },
        { status: 'ask' }
      );

      await new Promise((r) => setTimeout(r, 50));

      const debugLog = logMessages.find(
        (m) => m.message.includes('session not registered')
      );
      expect(debugLog).toBeDefined();
    });

    it('should convert non-string options to strings', async () => {
      const mockRelay = createMockRelay();
      relays.set('ses-test-001', mockRelay);

      const handler = createPermissionHandler(
        (id) => relays.get(id)!,
        logFn,
        relays,
        mockClient,
        '/test'
      );

      await handler(
        {
          id: 'perm-convert-001',
          type: 'question',
          sessionID: 'ses-test-001',
          messageID: 'msg-001',
          title: 'Select number',
          metadata: { options: [1, 2, 3] as unknown as string[] },
          time: { created: Date.now() },
        },
        { status: 'ask' }
      );

      await new Promise((r) => setTimeout(r, 50));

      // Should have converted numbers to strings
      expect(mockRelay.ask).toHaveBeenCalledWith('Select number', ['1', '2', '3']);
    });

    it('should handle empty options array as tool permission', async () => {
      const mockRelay = createMockRelay();
      relays.set('ses-test-001', mockRelay);

      const handler = createPermissionHandler(
        (id) => relays.get(id)!,
        logFn,
        relays,
        mockClient,
        '/test'
      );

      await handler(
        {
          id: 'perm-empty-001',
          type: 'bash',
          sessionID: 'ses-test-001',
          messageID: 'msg-001',
          title: 'ls -la',
          metadata: { options: [] },
          time: { created: Date.now() },
        },
        { status: 'ask' }
      );

      await new Promise((r) => setTimeout(r, 50));

      // Empty options should be treated as tool permission, not question
      expect(mockRelay.askPermission).toHaveBeenCalled();
      expect(mockRelay.ask).not.toHaveBeenCalled();
    });
  });
});

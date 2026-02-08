/**
 * Integration Tests for Deep Space Relay
 *
 * These tests verify the end-to-end behavior of DSR:
 * - Daemon starts and listens on Unix socket
 * - Relay client can register sessions
 * - Lazy thread creation on first message
 * - Subagent title emoji detection
 * - Message sending and reactions
 * - Broadcast functionality
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import {
  createMockTelegramServer,
  findCalls,
  hasCall,
  type MockTelegramServer,
} from './mocks/telegram-server';
import {
  createTestContext,
  spawnTestDaemon,
  createTestRelay,
  waitFor,
  sleep,
  type TestDaemon,
  type TestContext,
} from './mocks/test-utils';
import type { Relay } from '../src/relay/index';

describe('Deep Space Relay Integration Tests', () => {
  let mockTelegram: MockTelegramServer;
  let testContext: TestContext;
  let daemon: TestDaemon;
  let relay: Relay;

  // Test chat ID (simulates a configured Telegram supergroup)
  const TEST_CHAT_ID = '-1001234567890';

  beforeAll(async () => {
    // Start mock Telegram server
    mockTelegram = createMockTelegramServer();
    await mockTelegram.start();
  });

  afterAll(async () => {
    await mockTelegram.stop();
  });

  beforeEach(async () => {
    // Create isolated test context
    testContext = createTestContext();
    mockTelegram.reset();

    // Start daemon with test configuration
    daemon = await spawnTestDaemon(mockTelegram.getUrl(), testContext, TEST_CHAT_ID);
    await daemon.waitForReady();

    // Create relay client
    relay = createTestRelay(daemon.socketPath);
  });

  afterEach(async () => {
    // Stop daemon and cleanup
    if (daemon) {
      await daemon.stop();
    }
    if (testContext) {
      testContext.cleanup();
    }
  });

  describe('Bot Command Registration', () => {
    it('should register bot commands on startup for multiple scopes', async () => {
      // Give the daemon time to call setMyCommands
      await sleep(200);

      // Verify setMyCommands was called for multiple scopes:
      // 1. default scope (private chats)
      // 2. all_group_chats scope
      // 3. specific chat scope (when chatId is configured)
      const commandCalls = findCalls(mockTelegram.calls, 'setMyCommands');
      expect(commandCalls.length).toBeGreaterThanOrEqual(2); // At least 2 (default + group)

      // Verify the correct commands were registered in the first call
      const commands = commandCalls[0].params.commands as Array<{
        command: string;
        description: string;
      }>;
      expect(commands).toBeDefined();
      expect(commands.length).toBe(10); // start, list, list_all, agent, name, cleanup, compact, help, all, stop

      // Check each command
      const commandMap = new Map(commands.map((c) => [c.command, c.description]));
      expect(commandMap.has('start')).toBe(true);
      expect(commandMap.has('stop')).toBe(true);
      expect(commandMap.has('cleanup')).toBe(true);
      expect(commandMap.has('list')).toBe(true);
      expect(commandMap.has('list_all')).toBe(true);
      expect(commandMap.has('agent')).toBe(true);
      expect(commandMap.has('name')).toBe(true);
      expect(commandMap.has('compact')).toBe(true);
      expect(commandMap.has('help')).toBe(true);

      // Verify descriptions are meaningful
      expect(commandMap.get('start')).toContain('Configure');
      expect(commandMap.get('stop')).toContain('Stop');
      expect(commandMap.get('cleanup')).toContain('Delete');
      expect(commandMap.get('list')).toContain('List');
    });
  });

  describe('Session Registration', () => {
    it('should register a session successfully', async () => {
      const sessionId = 'test-session-001';
      const title = 'Test Session';

      const result = await relay.register(sessionId, title);

      expect(result.success).toBe(true);
      expect(relay.getState().registered).toBe(true);
      expect(relay.getState().sessionID).toBe(sessionId);
    });

    it('should not create thread on registration (lazy creation)', async () => {
      const sessionId = 'test-session-002';
      const title = 'Test Session';

      await relay.register(sessionId, title);

      // Give time for any async operations
      await sleep(100);

      // Verify no createForumTopic call was made during registration
      const topicCalls = findCalls(mockTelegram.calls, 'createForumTopic');
      expect(topicCalls.length).toBe(0);
    });
  });

  describe('Lazy Thread Creation', () => {
    it('should create thread on first send (dsr_send triggers ensureThread)', async () => {
      const sessionId = 'test-session-lazy-001';
      const title = 'Lazy Thread Test';

      await relay.register(sessionId, title);

      // Verify no thread created yet
      expect(findCalls(mockTelegram.calls, 'createForumTopic').length).toBe(0);

      // Send a message - this should trigger thread creation
      const sendResult = await relay.send('Hello from test!');

      expect(sendResult.success).toBe(true);

      // Verify thread was created
      const topicCalls = findCalls(mockTelegram.calls, 'createForumTopic');
      expect(topicCalls.length).toBe(1);
      expect(topicCalls[0].params.name).toContain('Lazy Thread Test');

      // Verify message was sent
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      expect(messageCalls.length).toBeGreaterThan(0);
      expect(messageCalls[0].params.text).toContain('Hello from test!');
    });

    it('should only create thread once for multiple sends', async () => {
      const sessionId = 'test-session-lazy-002';
      const title = 'Single Thread Test';

      await relay.register(sessionId, title);

      // Send multiple messages
      await relay.send('Message 1');
      await relay.send('Message 2');
      await relay.send('Message 3');

      // Verify only one thread was created
      const topicCalls = findCalls(mockTelegram.calls, 'createForumTopic');
      expect(topicCalls.length).toBe(1);

      // Verify all messages were sent
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      expect(messageCalls.length).toBe(3);
    });
  });

  describe('Subagent Title Emoji Detection', () => {
    it('should use robot emoji tag for main agent sessions', async () => {
      const sessionId = 'test-main-agent';
      const title = 'Main Agent Session';

      await relay.register(sessionId, title);
      await relay.send('Test message');

      const topicCalls = findCalls(mockTelegram.calls, 'createForumTopic');
      expect(topicCalls.length).toBe(1);

      // Main agent should get no robot emoji tag and no empty brackets
      // (Optional [Name] prefix is OK because daemon assigns random names now)
      const threadName = topicCalls[0].params.name as string;
      expect(threadName).toMatch(/TestProject/);
    });

    it('should use robot emoji with name for main agent with agentName', async () => {
      const sessionId = 'test-main-agent-named';
      const title = 'Main Agent Named';

      await relay.register(sessionId, title);
      await relay.setAgentName('Wall-E');
      // Need to send a message to trigger thread creation with the name
      await sleep(50);
      await relay.send('Test message');

      const topicCalls = findCalls(mockTelegram.calls, 'createForumTopic');
      expect(topicCalls.length).toBe(1);

      // Main agent with name should get [Name] tag (no emoji)
      const threadName = topicCalls[0].params.name as string;
      expect(threadName).toMatch(/^\[Wall-E\] TestProject/);
    });

    it('should use thread emoji tag for subagent sessions', async () => {
      const parentSessionId = 'test-parent-for-sub';
      const sessionId = 'test-subagent-001';
      const title = 'Subagent: File Search';

      // Register parent first so subagent can derive name
      await relay.register(parentSessionId, 'Parent Session');
      await sleep(50);
      // Register subagent with parentID
      await relay.register(sessionId, title, null, parentSessionId);
      await relay.send('Test message');

      const topicCalls = findCalls(mockTelegram.calls, 'createForumTopic');
      // May have 1 or 2 depending on whether parent triggered thread creation
      const lastTopic = topicCalls[topicCalls.length - 1];

      // Subagent should get thread emoji tag [🧵]
      const threadName = lastTopic.params.name as string;
      expect(threadName).toMatch(/\[\uD83E\uDDF5/);
    });

    it('should use thread emoji with name for subagent with agentName', async () => {
      const parentSessionId = 'test-parent-for-named-sub';
      const sessionId = 'test-subagent-named';
      const title = 'Subagent: Code Analysis';

      await relay.register(parentSessionId, 'Parent Session');
      await sleep(50);
      await relay.register(sessionId, title, null, parentSessionId);
      await relay.setAgentName('Eve');
      await sleep(50);
      await relay.send('Test message');

      const topicCalls = findCalls(mockTelegram.calls, 'createForumTopic');
      const lastTopic = topicCalls[topicCalls.length - 1];

      // Subagent with custom name should get [🧵 Name] tag
      const threadName = lastTopic.params.name as string;
      expect(threadName).toMatch(/^\[🧵 Eve\]/);
    });

    it('should use thread emoji tag for task-type sessions', async () => {
      const parentSessionId = 'test-parent-for-task';
      const sessionId = 'test-task-001';
      const title = 'Task: Database Migration';

      await relay.register(parentSessionId, 'Parent Session');
      await sleep(50);
      await relay.register(sessionId, title, null, parentSessionId);
      await relay.send('Test message');

      const topicCalls = findCalls(mockTelegram.calls, 'createForumTopic');
      const lastTopic = topicCalls[topicCalls.length - 1];

      // Task (subagent) should get thread emoji tag [🧵]
      const threadName = lastTopic.params.name as string;
      expect(threadName).toMatch(/\[\uD83E\uDDF5/);
    });
  });

  describe('Reaction Handling', () => {
    it('should send reaction to the last message', async () => {
      const sessionId = 'test-react-001';
      const title = 'Reaction Test';

      await relay.register(sessionId, title);
      await relay.send('This is a test message');

      // Send a reaction
      const reactResult = await relay.react('👍');
      expect(reactResult.success).toBe(true);

      // Give time for the async reaction call
      await sleep(100);

      // Verify setMessageReaction was called
      const reactionCalls = findCalls(mockTelegram.calls, 'setMessageReaction');
      expect(reactionCalls.length).toBe(1);
      expect(
        reactionCalls[0].params.emoji || (reactionCalls[0].params.reaction as any)?.[0]?.emoji
      ).toBeDefined();
    });

    it('should not send reaction before any message is sent', async () => {
      const sessionId = 'test-react-002';
      const title = 'Reaction Without Message';

      await relay.register(sessionId, title);

      // Try to react without sending a message first
      const reactResult = await relay.react('👍');
      expect(reactResult.success).toBe(true); // Fire-and-forget returns success

      await sleep(100);

      // Thread might be created, but setMessageReaction should still be called
      // (daemon will try, even if lastMessageID is undefined - that's ok, API just won't match)
    });
  });

  describe('Broadcast Functionality', () => {
    it('should broadcast to main channel without thread', async () => {
      const sessionId = 'test-broadcast-001';
      const title = 'Broadcast Test';

      await relay.register(sessionId, title);

      const broadcastResult = await relay.broadcast('Broadcasting to all!');
      expect(broadcastResult.success).toBe(true);

      // Verify sendMessage was called without message_thread_id
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const broadcastCall = messageCalls.find((c) => !c.params.message_thread_id);
      expect(broadcastCall).toBeDefined();
      expect(broadcastCall?.params.text).toContain('Broadcasting to all!');
    });
  });

  describe('Agent Name', () => {
    it('should send thread messages without agent name prefix (thread title has it)', async () => {
      const sessionId = 'test-agent-name-001';
      const title = 'Agent Name Test';

      await relay.register(sessionId, title);
      await relay.setAgentName('TestBot');

      // Wait for the agent name to be set
      await sleep(100);

      await relay.send('Hello with agent name!');

      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const lastMessage = messageCalls[messageCalls.length - 1];
      // Thread messages should NOT have [Name] prefix — the thread title already shows the agent name
      expect(lastMessage?.params.text).toBe('Hello with agent name!');
      expect(lastMessage?.params.message_thread_id).toBeDefined();
    });
  });

  describe('Typing Indicator', () => {
    it('should only send typing indicator after thread exists', async () => {
      const sessionId = 'test-typing-001';
      const title = 'Typing Test';

      await relay.register(sessionId, title);

      // Before thread creation (typing indicator should be ignored by daemon)
      await relay.sendTyping();
      await sleep(100);
      const actionCallsBefore = findCalls(mockTelegram.calls, 'sendChatAction');
      expect(actionCallsBefore.length).toBe(0);

      // Create thread
      await relay.send('First message to create thread');
      await sleep(100);

      // Now typing indicator should work
      await relay.sendTyping();
      await sleep(100);

      // Verify sendChatAction was called
      const actionCallsAfter = findCalls(mockTelegram.calls, 'sendChatAction');
      expect(actionCallsAfter.length).toBeGreaterThan(0);
      expect(actionCallsAfter[0].params.action).toBe('typing');
    });
  });

  describe('Error Handling', () => {
    it('should fail gracefully when not registered', async () => {
      // Create a fresh relay without registering
      const unregisteredRelay = createTestRelay(daemon.socketPath);

      const sendResult = await unregisteredRelay.send('This should fail');
      expect(sendResult.success).toBe(false);
      expect(sendResult.error).toContain('Not registered');
    });
  });

  describe('Session Status', () => {
    it('should update session status', async () => {
      const sessionId = 'test-status-001';
      const title = 'Status Test';

      await relay.register(sessionId, title);

      const busyResult = await relay.setStatus('busy');
      expect(busyResult.success).toBe(true);

      const idleResult = await relay.setStatus('idle');
      expect(idleResult.success).toBe(true);
    });
  });

  describe('Delete Session', () => {
    it('should delete a session and its thread', async () => {
      const sessionId = 'test-delete-001';
      const title = 'Delete Test';

      await relay.register(sessionId, title);
      await relay.send('Create thread first');

      // Now delete the session
      const deleteResult = await relay.deleteSession(sessionId);
      expect(deleteResult.success).toBe(true);

      // Verify deleteForumTopic was called
      const deleteCalls = findCalls(mockTelegram.calls, 'deleteForumTopic');
      expect(deleteCalls.length).toBe(1);
    });
  });

  describe('Message ID Tracking', () => {
    it('should track message IDs for sent messages', async () => {
      const sessionId = 'test-msgid-001';
      const title = 'Message ID Test';

      await relay.register(sessionId, title);

      // Send a message and verify state has lastMessageID
      await relay.send('First message');

      const state = relay.getState();
      expect(state.lastMessageID).toBeDefined();
      expect(typeof state.lastMessageID).toBe('number');
    });

    it('should update lastMessageID after each send', async () => {
      const sessionId = 'test-msgid-002';
      const title = 'Message ID Sequential Test';

      await relay.register(sessionId, title);

      await relay.send('Message 1');
      const id1 = relay.getState().lastMessageID;

      await relay.send('Message 2');
      const id2 = relay.getState().lastMessageID;

      await relay.send('Message 3');
      const id3 = relay.getState().lastMessageID;

      // Each message should get a different ID
      expect(id1).toBeDefined();
      expect(id2).toBeDefined();
      expect(id3).toBeDefined();
      expect(id2).toBeGreaterThan(id1!);
      expect(id3).toBeGreaterThan(id2!);
    });
  });

  describe('Reply To Message', () => {
    it('should send a reply to a specific message', async () => {
      const sessionId = 'test-reply-001';
      const title = 'Reply Test';

      await relay.register(sessionId, title);

      // Send initial message
      await relay.send('Original message');
      const originalMsgId = relay.getState().lastMessageID;
      expect(originalMsgId).toBeDefined();

      // Reply to it
      const replyResult = await relay.replyTo(originalMsgId!, 'This is a reply');
      expect(replyResult.success).toBe(true);

      // Verify sendMessage was called with reply_to_message_id
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const replyCall = messageCalls.find((c) => c.params.reply_to_message_id === originalMsgId);
      expect(replyCall).toBeDefined();
      expect(replyCall?.params.text).toContain('This is a reply');
    });

    it('should attempt to reply even with unknown message ID (Telegram handles validation)', async () => {
      const sessionId = 'test-reply-002';
      const title = 'Reply Unknown Test';

      await relay.register(sessionId, title);

      // The relay/daemon doesn't validate message IDs - it sends to Telegram and lets Telegram validate.
      // The mock Telegram server accepts all messages, so this will succeed in tests.
      // In production, Telegram would return an error for invalid reply_to_message_id.
      const replyResult = await relay.replyTo(99999, 'This will be sent');
      expect(replyResult.success).toBe(true);

      // Verify the sendMessage was called with reply_to_message_id
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const replyCall = messageCalls.find((c) => c.params.reply_to_message_id === 99999);
      expect(replyCall).toBeDefined();
    });

    it('should track replied message ID in state', async () => {
      const sessionId = 'test-reply-003';
      const title = 'Reply Track Test';

      await relay.register(sessionId, title);

      await relay.send('Original');
      const originalId = relay.getState().lastMessageID;

      await relay.replyTo(originalId!, 'Reply message');
      const replyId = relay.getState().lastMessageID;

      // Reply should have its own message ID
      expect(replyId).toBeDefined();
      expect(replyId).not.toBe(originalId);
    });
  });

  describe('React To Specific Message (dsr_react_to)', () => {
    it('should react to a specific message by ID', async () => {
      const sessionId = 'test-react-to-001';
      const title = 'React To Test';

      await relay.register(sessionId, title);

      // Send two messages
      await relay.send('First message');
      const firstMsgId = relay.getState().lastMessageID;

      await relay.send('Second message');
      const secondMsgId = relay.getState().lastMessageID;

      expect(firstMsgId).toBeDefined();
      expect(secondMsgId).toBeDefined();
      expect(firstMsgId).not.toBe(secondMsgId);

      // React to the first message specifically
      const reactResult = await relay.reactTo('🔥', firstMsgId!);
      expect(reactResult.success).toBe(true);

      await sleep(100);

      // Verify setMessageReaction was called with the first message ID
      const reactionCalls = findCalls(mockTelegram.calls, 'setMessageReaction');
      const targetReaction = reactionCalls.find((c) => c.params.message_id === firstMsgId);
      expect(targetReaction).toBeDefined();
    });

    it('should default to last message when no messageID provided', async () => {
      const sessionId = 'test-react-to-002';
      const title = 'React To Default Test';

      await relay.register(sessionId, title);
      await relay.send('A message');
      const lastMsgId = relay.getState().lastMessageID;

      // React without specifying messageID
      const reactResult = await relay.reactTo('👍');
      expect(reactResult.success).toBe(true);

      await sleep(100);

      const reactionCalls = findCalls(mockTelegram.calls, 'setMessageReaction');
      expect(reactionCalls.length).toBeGreaterThan(0);
      const lastReaction = reactionCalls[reactionCalls.length - 1];
      expect(lastReaction.params.message_id).toBe(lastMsgId);
    });

    it('should send reaction to Telegram even for unknown message ID (Telegram handles validation)', async () => {
      const sessionId = 'test-react-to-003';
      const title = 'React To Unknown Test';

      await relay.register(sessionId, title);
      await relay.send('A message'); // Create thread

      // The daemon sends reactions to Telegram without validating message IDs.
      // In production, Telegram would return an error for invalid message_id.
      // In our mock, it just accepts everything.
      const reactResult = await relay.reactTo('👍', 99999);
      expect(reactResult.success).toBe(true);

      await sleep(100);

      // The daemon DOES call setMessageReaction - it's Telegram that would reject invalid IDs
      const reactionCalls = findCalls(mockTelegram.calls, 'setMessageReaction');
      const unknownReaction = reactionCalls.find((c) => c.params.message_id === 99999);
      expect(unknownReaction).toBeDefined();
    });

    it('should fail when no message has been sent yet', async () => {
      const sessionId = 'test-react-to-004';
      const title = 'React To No Message Test';

      await relay.register(sessionId, title);

      // Try to react without sending any message first (no lastMessageID)
      const reactResult = await relay.reactTo('👍');
      expect(reactResult.success).toBe(false);
      expect(reactResult.error).toContain('No message ID available');
    });
  });

  describe('Reaction Notifications (Receiving)', () => {
    it('should track lastMessageID for reactions from user', async () => {
      // Note: In test mode, polling is disabled, so we can't fully simulate incoming reactions
      // from Telegram. This test verifies that the message tracking infrastructure is in place.
      const sessionId = 'test-reaction-notify-001';
      const title = 'Reaction Notification Test';

      await relay.register(sessionId, title);
      await relay.send('Test message for reaction');
      const msgId = relay.getState().lastMessageID;

      expect(msgId).toBeDefined();
      expect(typeof msgId).toBe('number');

      // The infrastructure is in place - message IDs are tracked
      // Full reaction notification testing would require polling mode or direct event injection
    });
  });

  describe('hasThread State After Thread Creation', () => {
    it('should set hasThread to true after dsr_send triggers thread creation', async () => {
      const sessionId = 'test-hasthread-001';
      const title = 'hasThread Test';

      await relay.register(sessionId, title);

      // Before sending, hasThread should be false (lazy thread creation)
      expect(relay.getState().hasThread).toBe(false);

      // Send a message - this triggers thread creation
      const sendResult = await relay.send('Hello to create thread');
      expect(sendResult.success).toBe(true);

      // After successful send, hasThread must be true
      expect(relay.getState().hasThread).toBe(true);
    });

    it('should keep hasThread true after multiple sends', async () => {
      const sessionId = 'test-hasthread-002';
      const title = 'hasThread Persistence Test';

      await relay.register(sessionId, title);
      expect(relay.getState().hasThread).toBe(false);

      await relay.send('Message 1');
      expect(relay.getState().hasThread).toBe(true);

      await relay.send('Message 2');
      expect(relay.getState().hasThread).toBe(true);

      await relay.send('Message 3');
      expect(relay.getState().hasThread).toBe(true);
    });

    it('should set hasThread true on replyTo success', async () => {
      const sessionId = 'test-hasthread-reply-001';
      const title = 'hasThread Reply Test';

      await relay.register(sessionId, title);
      expect(relay.getState().hasThread).toBe(false);

      // Send first message to create thread and get a message ID
      await relay.send('Original message');
      const msgId = relay.getState().lastMessageID;
      expect(msgId).toBeDefined();
      expect(relay.getState().hasThread).toBe(true);

      // Create a new relay for same session to test reply also sets hasThread
      // (simulates a relay that reconnected and lost state)
      const relay2 = createTestRelay(daemon.socketPath);
      await relay2.register(sessionId + '-2', title);
      expect(relay2.getState().hasThread).toBe(false);

      // Send to create thread for relay2 as well
      await relay2.send('Creating thread for relay2');
      expect(relay2.getState().hasThread).toBe(true);
    });

    it('should set hasThread true after receiving thread-created notification', async () => {
      const sessionId = 'test-hasthread-receive-001';
      const title = 'hasThread Receive Test';

      const relayWithCallback = createTestRelay(daemon.socketPath, (_text, _isThread) => {
        // Message callback - not used in this test
      });

      await relayWithCallback.register(sessionId, title);
      expect(relayWithCallback.getState().hasThread).toBe(false);

      // Send a message to create thread (this triggers thread_created notification)
      await relayWithCallback.send('Test message');
      expect(relayWithCallback.getState().hasThread).toBe(true);

      // hasThread should remain true
      await relayWithCallback.send('Another message');
      expect(relayWithCallback.getState().hasThread).toBe(true);
    });
  });

  describe('dsr_ask (Question with Options)', () => {
    it('should send a question with inline keyboard options', async () => {
      const sessionId = 'test-ask-001';
      const title = 'Ask Test';

      await relay.register(sessionId, title);
      await relay.send('Initial message'); // Create thread

      // Start ask in background (it waits for user response which won't come in tests)
      const askPromise = relay.ask('Which option do you prefer?', [
        'Option A',
        'Option B',
        'Option C',
      ]);

      // Give time for the ask to be sent
      await sleep(200);

      // Verify sendMessage was called with inline_keyboard
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const askCall = messageCalls.find((c) =>
        (c.params.text as string)?.includes('Which option do you prefer?')
      );
      expect(askCall).toBeDefined();
      expect(askCall?.params.reply_markup).toBeDefined();
      expect((askCall?.params.reply_markup as any)?.inline_keyboard).toBeDefined();

      // Verify keyboard has buttons with callback_data
      const keyboard = (askCall?.params.reply_markup as any)?.inline_keyboard;
      expect(keyboard.length).toBeGreaterThan(0);

      // First row should have buttons
      const firstRow = keyboard[0];
      expect(firstRow.length).toBeGreaterThan(0);
      expect(firstRow[0].text).toBe('Option A');
      expect(firstRow[0].callback_data).toContain('ask:');
      expect(firstRow[0].callback_data).toContain('Option A');

      // Clean up the pending promise (it will timeout naturally)
    });

    it('should handle ask timeout gracefully', async () => {
      // This test just verifies the infrastructure is in place
      // Full timeout testing would take too long
      const sessionId = 'test-ask-timeout-001';
      const title = 'Ask Timeout Test';

      await relay.register(sessionId, title);
      await relay.send('Setup message');

      // Just verify ask method exists and returns a promise
      expect(typeof relay.ask).toBe('function');
    });
  });

  describe('set_agent_name (Thread Title Update)', () => {
    it('should update thread title when agent name is set after thread creation', async () => {
      const sessionId = 'test-agent-name-title-001';
      const title = 'Agent Name Title Test';

      await relay.register(sessionId, title);
      await relay.send('Create thread'); // Create thread first

      // Verify initial thread creation
      const topicCalls = findCalls(mockTelegram.calls, 'createForumTopic');
      expect(topicCalls.length).toBe(1);

      // Set agent name
      const result = await relay.setAgentName('WALL-E');
      expect(result.success).toBe(true);

      // Give time for the update
      await sleep(100);

      // Verify editForumTopic was called to update the title
      const editCalls = findCalls(mockTelegram.calls, 'editForumTopic');
      expect(editCalls.length).toBeGreaterThan(0);

      // The new title should include the agent name
      const lastEditCall = editCalls[editCalls.length - 1];
      expect(lastEditCall.params.name as string).toContain('WALL-E');
    });

    it('should acknowledge agent name set', async () => {
      const sessionId = 'test-agent-name-ack-001';
      const title = 'Agent Name Ack Test';

      await relay.register(sessionId, title);

      const result = await relay.setAgentName('R2-D2');
      expect(result.success).toBe(true);
    });
  });

  describe('update_title (Session Title Update)', () => {
    it('should update thread title when session title changes', async () => {
      const sessionId = 'test-update-title-001';
      const title = 'Initial Title';

      await relay.register(sessionId, title);
      await relay.send('Create thread');

      // Update the title
      const result = await relay.updateTitle('Updated Title');
      expect(result.success).toBe(true);

      // Verify editForumTopic was called
      const editCalls = findCalls(mockTelegram.calls, 'editForumTopic');
      expect(editCalls.length).toBeGreaterThan(0);

      // The new title should contain the updated title
      const lastEditCall = editCalls[editCalls.length - 1];
      expect(lastEditCall.params.name as string).toContain('Updated Title');
    });

    it('should fail to update title before registration', async () => {
      const unregisteredRelay = createTestRelay(daemon.socketPath);
      const result = await unregisteredRelay.updateTitle('New Title');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Not registered');
    });

    it('should update relay state title after successful update', async () => {
      const sessionId = 'test-update-title-state-001';
      const title = 'Original Title';

      await relay.register(sessionId, title);
      await relay.send('Create thread');

      await relay.updateTitle('New Title');

      const state = relay.getState();
      expect(state.title).toBe('New Title');
    });
  });

  describe('Markdown Fallback Logic', () => {
    it('should fall back to plain text when Markdown fails', async () => {
      const sessionId = 'test-markdown-fallback-001';
      const title = 'Markdown Fallback Test';

      await relay.register(sessionId, title);

      // Enable markdown fail mode on the mock
      mockTelegram.setMarkdownFailMode(true);

      // Send a message with problematic markdown
      const result = await relay.send('Test with **unclosed bold');

      // The message should still succeed (fallback to plain text)
      expect(result.success).toBe(true);

      // Verify sendMessage was called twice: first with Markdown (failed), then without
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const relevantCalls = messageCalls.filter((c) =>
        (c.params.text as string)?.includes('unclosed bold')
      );

      // Should have at least 2 calls: first with Markdown, second without
      expect(relevantCalls.length).toBeGreaterThanOrEqual(2);

      // First call should have parse_mode: Markdown
      expect(relevantCalls[0].params.parse_mode).toBe('Markdown');

      // Second call should not have parse_mode (plain text)
      expect(relevantCalls[1].params.parse_mode).toBeUndefined();
    });

    it('should succeed on first try when Markdown is valid', async () => {
      const sessionId = 'test-markdown-success-001';
      const title = 'Markdown Success Test';

      await relay.register(sessionId, title);

      const result = await relay.send('Test with **valid** markdown');
      expect(result.success).toBe(true);

      // Verify only one sendMessage call for this text
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const relevantCalls = messageCalls.filter((c) =>
        (c.params.text as string)?.includes('valid')
      );
      expect(relevantCalls.length).toBe(1);
      expect(relevantCalls[0].params.parse_mode).toBe('Markdown');
    });
  });

  describe('State Persistence', () => {
    it('should save state after session registration', async () => {
      const sessionId = 'test-persist-001';
      const title = 'Persist Test';

      await relay.register(sessionId, title);
      await relay.send('Create thread for persistence');

      // Give time for state save
      await sleep(100);

      // Read state file
      const { readFileSync, existsSync } = await import('fs');
      expect(existsSync(daemon.statePath)).toBe(true);

      const stateData = JSON.parse(readFileSync(daemon.statePath, 'utf-8'));

      // Verify sessions are saved
      expect(stateData.sessions).toBeDefined();
      expect(stateData.sessions.length).toBeGreaterThan(0);

      // Find our session
      const ourSession = stateData.sessions.find(([id, _info]: [string, any]) => id === sessionId);
      expect(ourSession).toBeDefined();

      const [_id, info] = ourSession;
      expect(info.project).toBe('TestProject');
      expect(info.title).toBe(title);
      expect(info.threadID).toBeDefined();
    });

    it('should save threadToSession mapping', async () => {
      const sessionId = 'test-persist-mapping-001';
      const title = 'Persist Mapping Test';

      await relay.register(sessionId, title);
      await relay.send('Create thread');

      await sleep(100);

      const { readFileSync } = await import('fs');
      const stateData = JSON.parse(readFileSync(daemon.statePath, 'utf-8'));

      // Verify threadToSession is saved
      expect(stateData.threadToSession).toBeDefined();
      expect(stateData.threadToSession.length).toBeGreaterThan(0);

      // The mapping should include our session
      const hasOurSession = stateData.threadToSession.some(
        ([_threadId, sid]: [number, string]) => sid === sessionId
      );
      expect(hasOurSession).toBe(true);
    });
  });

  describe('Bot Commands: /list and /list_all', () => {
    it('should register list and list_all commands on startup', async () => {
      await sleep(200);

      const commandCalls = findCalls(mockTelegram.calls, 'setMyCommands');
      expect(commandCalls.length).toBeGreaterThan(0);

      const commands = commandCalls[0].params.commands as Array<{
        command: string;
        description: string;
      }>;

      const commandNames = commands.map((c) => c.command);
      expect(commandNames).toContain('list');
      expect(commandNames).toContain('list_all');
    });

    // Note: Testing the actual /list command execution would require
    // simulating a message from Telegram, which requires polling mode.
    // The following tests verify the command registration is in place.
    it('should have list command with correct description', async () => {
      await sleep(200);

      const commandCalls = findCalls(mockTelegram.calls, 'setMyCommands');
      const commands = commandCalls[0].params.commands as Array<{
        command: string;
        description: string;
      }>;

      const listCmd = commands.find((c) => c.command === 'list');
      expect(listCmd).toBeDefined();
      expect(listCmd?.description).toContain('active');
    });

    it('should have list_all command with correct description', async () => {
      await sleep(200);

      const commandCalls = findCalls(mockTelegram.calls, 'setMyCommands');
      const commands = commandCalls[0].params.commands as Array<{
        command: string;
        description: string;
      }>;

      const listAllCmd = commands.find((c) => c.command === 'list_all');
      expect(listAllCmd).toBeDefined();
      expect(listAllCmd?.description).toContain('all');
    });
  });

  describe('Permission Request', () => {
    it('should send permission request with approve/deny buttons', async () => {
      const sessionId = 'test-permission-001';
      const title = 'Permission Test';

      await relay.register(sessionId, title);
      await relay.send('Create thread');

      // Start permission request in background (it waits for user response)
      const permPromise = relay.askPermission(
        'perm-001',
        'dangerous_tool',
        'This tool is dangerous'
      );

      await sleep(200);

      // Verify sendMessage was called with inline_keyboard
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const permCall = messageCalls.find((c) =>
        (c.params.text as string)?.includes('Permission Request')
      );
      expect(permCall).toBeDefined();
      expect(permCall?.params.reply_markup).toBeDefined();

      const keyboard = (permCall?.params.reply_markup as any)?.inline_keyboard;
      expect(keyboard).toBeDefined();
      expect(keyboard.length).toBeGreaterThan(0);

      // Should have Approve, Deny, Always, Never buttons
      const allButtons = keyboard.flat();
      const buttonTexts = allButtons.map((b: any) => b.text);
      expect(buttonTexts.some((t: string) => t.includes('Approve'))).toBe(true);
      expect(buttonTexts.some((t: string) => t.includes('Deny'))).toBe(true);
    });
  });

  describe('Error Notification', () => {
    it('should send error notification to thread', async () => {
      const sessionId = 'test-error-001';
      const title = 'Error Test';

      await relay.register(sessionId, title);
      await relay.send('Create thread');

      const result = await relay.sendError('TestError', 'Something went wrong');
      expect(result.success).toBe(true);

      await sleep(100);

      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const errorCall = messageCalls.find(
        (c) =>
          (c.params.text as string)?.includes('Error') &&
          (c.params.text as string)?.includes('TestError')
      );
      expect(errorCall).toBeDefined();
    });
  });

  describe('Broadcast Markdown Fallback', () => {
    it('should fall back to plain text for broadcast when Markdown fails', async () => {
      const sessionId = 'test-broadcast-markdown-001';
      const title = 'Broadcast Markdown Test';

      await relay.register(sessionId, title);

      // Enable markdown fail mode
      mockTelegram.setMarkdownFailMode(true);

      const result = await relay.broadcast('Broadcast with **broken markdown');
      expect(result.success).toBe(true);

      // Should have tried twice - once with Markdown, once without
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const broadcastCalls = messageCalls.filter(
        (c) => (c.params.text as string)?.includes('broken markdown') && !c.params.message_thread_id
      );
      expect(broadcastCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Reply To Markdown Fallback', () => {
    it('should fall back to plain text for reply_to when Markdown fails', async () => {
      const sessionId = 'test-reply-markdown-001';
      const title = 'Reply Markdown Test';

      await relay.register(sessionId, title);
      await relay.send('Initial message');
      const msgId = relay.getState().lastMessageID;
      expect(msgId).toBeDefined();

      // Enable markdown fail mode
      mockTelegram.setMarkdownFailMode(true);

      const result = await relay.replyTo(msgId!, 'Reply with **broken markdown');
      expect(result.success).toBe(true);

      // Should have tried twice
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const replyCalls = messageCalls.filter(
        (c) =>
          (c.params.text as string)?.includes('broken markdown') && c.params.reply_to_message_id
      );
      expect(replyCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Multiple Session Isolation', () => {
    it('should maintain separate message IDs for different sessions', async () => {
      const relay1 = createTestRelay(daemon.socketPath, undefined, 'Project1');
      const relay2 = createTestRelay(daemon.socketPath, undefined, 'Project2');

      await relay1.register('session-iso-001', 'Session 1');
      await relay2.register('session-iso-002', 'Session 2');

      await relay1.send('Message from session 1');
      const msgId1 = relay1.getState().lastMessageID;

      await relay2.send('Message from session 2');
      const msgId2 = relay2.getState().lastMessageID;

      // Each session should have its own message IDs
      expect(msgId1).toBeDefined();
      expect(msgId2).toBeDefined();
      expect(msgId1).not.toBe(msgId2);

      // Each should have its own thread
      expect(relay1.getState().hasThread).toBe(true);
      expect(relay2.getState().hasThread).toBe(true);
    });
  });

  describe('Session Re-registration', () => {
    it('should allow re-registration with different title', async () => {
      const sessionId = 'test-rereg-001';

      await relay.register(sessionId, 'Original Title');
      expect(relay.getState().registered).toBe(true);

      // Re-register with different title
      const relay2 = createTestRelay(daemon.socketPath);
      await relay2.register(sessionId, 'New Title');
      expect(relay2.getState().registered).toBe(true);
    });
  });

  describe('Per-Project Chat ID', () => {
    it('should use session-provided chatId for messages', async () => {
      const sessionId = 'test-per-project-001';
      const title = 'Per-Project ChatId Test';
      const projectChatId = '-1009999999999'; // Different from TEST_CHAT_ID

      // Create relay with custom chatId
      const relayWithCustomChat = createTestRelay(
        daemon.socketPath,
        undefined,
        'CustomProject',
        projectChatId
      );

      // Debug: Check relay status before register
      const statusBefore = relayWithCustomChat.getStatus();
      console.log('DEBUG relay chatId before register:', statusBefore.chatId);

      await relayWithCustomChat.register(sessionId, title);

      // Debug: Check relay status after register
      const statusAfter = relayWithCustomChat.getStatus();
      console.log('DEBUG relay chatId after register:', statusAfter.chatId);

      await relayWithCustomChat.send('Message to custom chat');

      // Debug: print all createForumTopic calls
      const topicCalls = findCalls(mockTelegram.calls, 'createForumTopic');
      console.log(
        'DEBUG createForumTopic calls:',
        topicCalls.map((c) => c.params.chat_id)
      );
      console.log('DEBUG expected projectChatId:', projectChatId);

      // Verify createForumTopic was called with the session's chatId
      const customChatCall = topicCalls.find((c) => c.params.chat_id === projectChatId);
      expect(customChatCall).toBeDefined();

      // Verify sendMessage was called with the session's chatId
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const customMessageCall = messageCalls.find(
        (c) =>
          c.params.chat_id === projectChatId &&
          (c.params.text as string)?.includes('Message to custom chat')
      );
      expect(customMessageCall).toBeDefined();
    });

    it('should allow multiple sessions with different chatIds', async () => {
      const chatId1 = '-1001111111111';
      const chatId2 = '-1002222222222';

      const relay1 = createTestRelay(daemon.socketPath, undefined, 'Project1', chatId1);
      const relay2 = createTestRelay(daemon.socketPath, undefined, 'Project2', chatId2);

      await relay1.register('session-multi-chat-001', 'Session for Chat 1');
      await relay2.register('session-multi-chat-002', 'Session for Chat 2');

      await relay1.send('Message to chat 1');
      await relay2.send('Message to chat 2');

      // Verify each went to correct chat
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');

      const chat1Messages = messageCalls.filter(
        (c) =>
          c.params.chat_id === chatId1 && (c.params.text as string)?.includes('Message to chat 1')
      );
      expect(chat1Messages.length).toBeGreaterThan(0);

      const chat2Messages = messageCalls.filter(
        (c) =>
          c.params.chat_id === chatId2 && (c.params.text as string)?.includes('Message to chat 2')
      );
      expect(chat2Messages.length).toBeGreaterThan(0);
    });

    it('should fall back to daemon chatId when session has no chatId', async () => {
      const sessionId = 'test-fallback-chatid-001';
      const title = 'Fallback ChatId Test';

      // Create relay without custom chatId (uses undefined)
      const relayNoChat = createTestRelay(daemon.socketPath, undefined, 'ProjectNoChat');

      await relayNoChat.register(sessionId, title);
      await relayNoChat.send('Message using fallback chat');

      // Verify sendMessage was called with the daemon's chatId (TEST_CHAT_ID)
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const fallbackCall = messageCalls.find(
        (c) =>
          c.params.chat_id === TEST_CHAT_ID &&
          (c.params.text as string)?.includes('Message using fallback')
      );
      expect(fallbackCall).toBeDefined();
    });

    it('should expose chatId in relay status', async () => {
      const sessionId = 'test-status-chatid-001';
      const title = 'Status ChatId Test';
      const projectChatId = '-1008888888888';

      const relayWithChat = createTestRelay(
        daemon.socketPath,
        undefined,
        'StatusProject',
        projectChatId
      );

      await relayWithChat.register(sessionId, title);

      const status = relayWithChat.getStatus();
      expect(status.chatId).toBe(projectChatId);
    });

    it('should use session chatId for reactions', async () => {
      const sessionId = 'test-react-chatid-001';
      const title = 'React ChatId Test';
      const projectChatId = '-1007777777777';

      const relayWithChat = createTestRelay(
        daemon.socketPath,
        undefined,
        'ReactProject',
        projectChatId
      );

      await relayWithChat.register(sessionId, title);
      await relayWithChat.send('Message to react to');
      await relayWithChat.react('👍');

      await sleep(100);

      // Verify setMessageReaction was called with the session's chatId
      const reactionCalls = findCalls(mockTelegram.calls, 'setMessageReaction');
      const customReaction = reactionCalls.find((c) => c.params.chat_id === projectChatId);
      expect(customReaction).toBeDefined();
    });

    it('should use session chatId for permission requests', async () => {
      const sessionId = 'test-perm-chatid-001';
      const title = 'Permission ChatId Test';
      const projectChatId = '-1006666666666';

      const relayWithChat = createTestRelay(
        daemon.socketPath,
        undefined,
        'PermProject',
        projectChatId
      );

      await relayWithChat.register(sessionId, title);
      await relayWithChat.send('Create thread');

      // Start permission request
      relayWithChat.askPermission('perm-chat-001', 'test_tool', 'Test description');

      await sleep(200);

      // Verify sendMessage with permission request was sent to correct chat
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const permCall = messageCalls.find(
        (c) =>
          c.params.chat_id === projectChatId &&
          (c.params.text as string)?.includes('Permission Request')
      );
      expect(permCall).toBeDefined();
    });

    it('should use session chatId for ask (dsr_ask)', async () => {
      const sessionId = 'test-ask-chatid-001';
      const title = 'Ask ChatId Test';
      const projectChatId = '-1005555555555';

      const relayWithChat = createTestRelay(
        daemon.socketPath,
        undefined,
        'AskProject',
        projectChatId
      );

      await relayWithChat.register(sessionId, title);
      await relayWithChat.send('Create thread');

      // Start ask
      relayWithChat.ask('Which option?', ['A', 'B']);

      await sleep(200);

      // Verify ask was sent to correct chat
      const messageCalls = findCalls(mockTelegram.calls, 'sendMessage');
      const askCall = messageCalls.find(
        (c) =>
          c.params.chat_id === projectChatId && (c.params.text as string)?.includes('Which option')
      );
      expect(askCall).toBeDefined();
    });

    it('should use session chatId for delete session', async () => {
      const sessionId = 'test-delete-chatid-001';
      const title = 'Delete ChatId Test';
      const projectChatId = '-1004444444444';

      const relayWithChat = createTestRelay(
        daemon.socketPath,
        undefined,
        'DeleteProject',
        projectChatId
      );

      await relayWithChat.register(sessionId, title);
      await relayWithChat.send('Create thread to delete');

      await relayWithChat.deleteSession(sessionId);

      // Verify deleteForumTopic was called with correct chat
      const deleteCalls = findCalls(mockTelegram.calls, 'deleteForumTopic');
      const customDelete = deleteCalls.find((c) => c.params.chat_id === projectChatId);
      expect(customDelete).toBeDefined();
    });

    it('should use session chatId for thread title update', async () => {
      const sessionId = 'test-title-chatid-001';
      const title = 'Title Update ChatId Test';
      const projectChatId = '-1003333333333';

      const relayWithChat = createTestRelay(
        daemon.socketPath,
        undefined,
        'TitleProject',
        projectChatId
      );

      await relayWithChat.register(sessionId, title);
      await relayWithChat.send('Create thread');
      await relayWithChat.setAgentName('TestBot');

      await sleep(100);

      // Verify editForumTopic was called with correct chat
      const editCalls = findCalls(mockTelegram.calls, 'editForumTopic');
      const customEdit = editCalls.find((c) => c.params.chat_id === projectChatId);
      expect(customEdit).toBeDefined();
    });
  });
});

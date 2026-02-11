BUG: isKnownProjectChat guard silently drops all commands from chats without active sessions

## Bug Description
The isKnownProjectChat check at line 167-174 in src/daemon/commands.ts drops ALL commands from chats without active sessions. This means commands like /cleanup, /list, /help, /agent sent from a chat with no active sessions will vanish silently with only a log entry.

## Impact
Users expect /list, /cleanup, /help, /agent to work regardless of whether sessions exist. These are daemon-level commands, not session-specific.

## Expected Behavior
Global commands (/list, /cleanup, /help) should bypass the isKnownProjectChat check and be processed unconditionally. Only session-specific messages should require a known chat.

## Current Code
src/daemon/commands.ts:167-174:
```typescript
const isKnownProjectChat = Array.from(state.sessions.values()).some(
  (s) => String(s.chatId) === String(msgChatId)
);
if (!isKnownProjectChat) {
  log(`[Daemon] Ignoring message from unknown chat: ${msgChatId}`, 'info');
  return;
}
```
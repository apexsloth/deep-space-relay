BUG: Wrong variable used in /stop command reaction (chatId vs msgChatId)

## Bug Description
In src/daemon/commands.ts:183, the code uses chatId (from getChatId()) instead of msgChatId (from msg.chat.id):

```typescript
chat_id: chatId,  // Uses getChatId() instead of msgChatId
```

## Impact
If chatId differs from msgChatId, the thumbs up reaction is sent to the wrong chat. This could happen if getChatId() returns a default or different chat ID.

## Expected Behavior
The reaction should be sent to the chat where the message was received (msgChatId).

## Current Code
src/daemon/commands.ts:181-186:
```typescript
await telegram.setMessageReaction({
  chat_id: chatId,
  message_id: msg.message_id,
  reaction: [{ type: 'emoji', emoji: '👍' }],
});
```

## Suggested Fix
Use msgChatId instead of chatId.
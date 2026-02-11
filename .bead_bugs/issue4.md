BUG: Thread messages lack feedback when forwarded to agents

## Bug Description
In src/daemon/commands.ts:561-644, messages in threads are forwarded to agents without any reaction or acknowledgment. If the agent is slow or disconnected, the message appears to vanish from the user's perspective.

## Impact
Users send messages in threads and see no response. They don't know if:
1. The message was received
2. The agent is processing
3. The agent is offline

## Expected Behavior
Add a reaction (e.g., 👀 or ⏳) when a message is received and being forwarded to the agent. This provides immediate visual feedback.

## Current Code
src/daemon/commands.ts:561-644:
```typescript
// Forward the message to the connected agent
if (client?.send) {
  client.send({
    type: 'command',
    sessionId: session.id,
    text: fullText,
  });
} else {
  // ...
}
```

## Suggested Fix
Add a setMessageReaction call before forwarding to acknowledge receipt.
BUG: Map mutation during iteration in cleanup command skips entries

## Bug Description
In src/daemon/commands.ts:197-206, the code deletes from state.sessions while iterating over it:

```typescript
for (const [sid, session] of state.sessions.entries()) {
  // ... cleanup logic ...
  state.sessions.delete(sid);  // BUG: Modifying Map during iteration
}
```

## Impact
In JavaScript, deleting from a Map while iterating can skip entries. Some stale sessions may never get cleaned up if they appear after a deleted entry in the iteration order.

## Expected Behavior
Collect all session IDs to delete first, then delete them in a separate loop.

## Suggested Fix
```typescript
const toDelete: string[] = [];
for (const [sid, session] of state.sessions.entries()) {
  // ... check if should delete ...
  toDelete.push(sid);
}
for (const sid of toDelete) {
  state.sessions.delete(sid);
}
```
---
id: dsr-if7y
status: in_progress
deps: [dsr-youi, dsr-930k]
links: []
created: 2026-03-07T17:58:08Z
type: task
priority: 1
assignee: apexsloth
parent: dsr-9n2c
tags: [backend, codex, transport]
---
# Implement codex-app-server transport

Add a codex-app-server adapter that manages connection setup, initialize handshake, thread ownership, and turn lifecycle for DSR-owned sessions.

## Acceptance Criteria

1. DSR can connect to a dedicated codex-app-server instance. 2. Telegram messages map to thread/turn operations correctly. 3. Session state tracks Codex thread and active turn ids.


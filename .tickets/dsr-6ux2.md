---
id: dsr-6ux2
status: open
deps: [dsr-youi]
links: []
created: 2026-03-07T17:58:08Z
type: task
priority: 1
assignee: apexsloth
parent: dsr-9n2c
tags: [backend, opencode]
---
# Extract OpenCode adapter

Move current OpenCode plugin/event/tool wiring behind an adapter implementation without changing behavior.

## Acceptance Criteria

1. Existing OpenCode entrypoints bootstrap an OpenCode adapter. 2. Current Telegram relay behavior is preserved. 3. Existing OpenCode-focused tests still pass after the extraction.


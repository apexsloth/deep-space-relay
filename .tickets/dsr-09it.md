---
id: dsr-09it
status: open
deps: [dsr-3kit]
links: []
created: 2026-03-07T17:58:08Z
type: task
priority: 1
assignee: apexsloth
parent: dsr-9n2c
tags: [test, backend, codex, opencode]
---
# Add dual-backend test coverage

Build contract/integration coverage so the same DSR behaviors are exercised against both the extracted OpenCode adapter and the new Codex adapter.

## Acceptance Criteria

1. Shared lifecycle expectations are tested at the adapter boundary. 2. Codex-specific transport and tool-call flows have dedicated coverage. 3. Existing Telegram/daemon integration tests are reused where practical.


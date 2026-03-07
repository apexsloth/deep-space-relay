---
id: dsr-9n2c
status: open
deps: []
links: []
created: 2026-03-07T17:57:47Z
type: epic
priority: 1
assignee: apexsloth
tags: [backend, codex, telegram, architecture]
---
# Add codex-app-server backend support

Add a second runtime backend so Deep Space Relay can target standalone codex-app-server while preserving the current OpenCode path. The relay should own Codex threads/sessions rather than relying on unsupported attachment to an arbitrary desktop UI tab.

## Design

Introduce a host adapter boundary between the Telegram/daemon core and host runtimes. Keep the daemon, relay socket protocol, Telegram bot, and session registry reusable. Move current OpenCode-specific plugin/event/tool logic behind an OpenCode adapter. Add a codex-app-server adapter that talks JSON-RPC to a dedicated app-server instance and uses DSR-owned threads plus dynamic tools for agent replies.

## Acceptance Criteria

1. OpenCode behavior remains available behind an adapter. 2. DSR can target a standalone codex-app-server instance and inject Telegram messages into a DSR-owned thread. 3. Agent replies can flow back to Telegram through DSR tool calls/dynamic tools. 4. Repo-scoped config can select backend and backend-specific settings. 5. Tests cover both backends at the contract level.


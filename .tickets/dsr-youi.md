---
id: dsr-youi
status: closed
deps: []
links: []
created: 2026-03-07T17:58:08Z
type: task
priority: 1
assignee: apexsloth
parent: dsr-9n2c
tags: [backend, architecture]
---
# Define host adapter boundary

Replace direct PluginContext/OpenCode coupling with host-neutral adapter interfaces and normalized lifecycle/message types.

## Acceptance Criteria

1. HostAdapter and related normalized types are defined. 2. OpenCode-specific types no longer leak through the shared daemon/relay core. 3. Session, message injection, permissions, and event subscription capabilities are represented explicitly.


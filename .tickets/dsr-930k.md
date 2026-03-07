---
id: dsr-930k
status: closed
deps: [dsr-youi]
links: []
created: 2026-03-07T17:58:08Z
type: task
priority: 1
assignee: apexsloth
parent: dsr-9n2c
tags: [config, backend]
---
# Add backend-aware repo config

Extend system/project config to select a backend and hold backend-specific runtime settings while keeping current chat selection behavior.

## Acceptance Criteria

1. Config can select OpenCode vs codex-app-server. 2. Project-level chat routing remains supported. 3. Backend-specific settings can be stored without breaking current config loading.


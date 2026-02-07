import type { Relay } from './relay/core';
import type { LogFn, PluginContext } from './types';

// ============================================================
// HOOKS
// ============================================================

// NOTE: Model switching via DSR has been removed.
// The relay no longer injects targetModel into chat params.
// OpenCode uses its own model selection without DSR interference.

import type { Plugin } from '@opencode-ai/plugin';
import { createOpenCodePlugin } from './opencode-adapter';

// ============================================================
// PLUGIN
// ============================================================

export const DeepSpaceRelay = createOpenCodePlugin() as unknown as Plugin;

export default DeepSpaceRelay;

// Re-export types for consumers
export type { Relay } from './relay/index';
export type { OpenCodePluginContext as PluginContext } from './opencode-types';
export type { RelayConfig, RelayState, LogFn } from './types';

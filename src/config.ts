import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECURE_DIR_MODE } from './constants';

// ============================================================
// CONFIG LOADER
// ============================================================

// Config paths (uses hyphen for consistency with project name)
const PROJECT_CONFIG_SUBDIR = '.opencode/deep-space-relay';

function resolveSystemConfigDir(): string {
  return join(process.env.HOME || '', '.config/opencode/deep-space-relay');
}

/**
 * Get the secure socket path (user-specific, not world-readable)
 * Prefers XDG_RUNTIME_DIR (typically /run/user/UID)
 * Falls back to ~/.local/state/opencode/
 */
export function getSocketPath(): string {
  // Use environment override if provided
  if (process.env.DSR_SOCKET_PATH) {
    return process.env.DSR_SOCKET_PATH;
  }

  // Prefer XDG_RUNTIME_DIR (user-specific, tmpfs, automatically cleaned up)
  if (process.env.XDG_RUNTIME_DIR) {
    const dir = process.env.XDG_RUNTIME_DIR;
    return join(dir, 'ds-relay.sock');
  }

  // Fallback to ~/.local/state/opencode/
  const stateDir = join(process.env.HOME || '', '.local/state/opencode');

  // Ensure directory exists with secure permissions (0700)
  try {
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true, mode: SECURE_DIR_MODE });
    }
  } catch (err) {
    // Critical error - cannot proceed without socket directory
    throw new Error(`Failed to create socket directory ${stateDir}: ${err}`);
  }

  return join(stateDir, 'ds-relay.sock');
}

/**
 * Get the secure PID file path (user-specific)
 */
export function getPIDPath(): string {
  // Use environment override if provided
  if (process.env.DSR_PID_PATH) {
    return process.env.DSR_PID_PATH;
  }

  const socketPath = getSocketPath();
  return socketPath.replace('.sock', '.pid');
}

export type DSRBackend = 'opencode' | 'codex-app-server';

export interface CodexAppServerConfig {
  transport?: 'stdio' | 'ws';
  command?: string;
  args?: string[];
  websocketUrl?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface DSRConfig {
  backend?: DSRBackend;
  token?: string;
  chatId?: string;
  ipcToken?: string;
  opencode?: Record<string, unknown>;
  codexAppServer?: CodexAppServerConfig;
}

const DEFAULT_BACKEND: DSRBackend = 'opencode';

function asConfigSection(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return { ...(value as Record<string, unknown>) };
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    return typeof entry[1] === 'string';
  });
  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function normalizeCodexAppServerConfig(value: unknown): CodexAppServerConfig | undefined {
  const section = asConfigSection(value);
  if (!section) {
    return undefined;
  }

  const config: CodexAppServerConfig = {};
  if (section.transport === 'stdio' || section.transport === 'ws') {
    config.transport = section.transport;
  }
  if (typeof section.command === 'string') {
    config.command = section.command;
  }
  if (Array.isArray(section.args)) {
    config.args = section.args.filter((arg): arg is string => typeof arg === 'string');
  }
  if (typeof section.websocketUrl === 'string') {
    config.websocketUrl = section.websocketUrl;
  }
  if (typeof section.cwd === 'string') {
    config.cwd = section.cwd;
  }
  const env = asStringMap(section.env);
  if (env) {
    config.env = env;
  }

  return Object.keys(config).length > 0 ? config : undefined;
}

function normalizeConfig(raw: Record<string, unknown>): Partial<DSRConfig> {
  const config: Partial<DSRConfig> = {};

  if (raw.backend === 'opencode' || raw.backend === 'codex-app-server') {
    config.backend = raw.backend as DSRBackend;
  }
  if (typeof raw.token === 'string') {
    config.token = raw.token;
  }
  if (typeof raw.chatId === 'string') {
    config.chatId = raw.chatId;
  }
  if (typeof raw.ipcToken === 'string') {
    config.ipcToken = raw.ipcToken;
  }

  const opencode = asConfigSection(raw.opencode);
  if (opencode) {
    config.opencode = opencode;
  }

  const codexAppServer = normalizeCodexAppServerConfig(raw.codexAppServer);
  if (codexAppServer) {
    config.codexAppServer = codexAppServer;
  }

  return config;
}

export function mergeDSRConfig(
  base: Partial<DSRConfig>,
  updates: Partial<DSRConfig>
): Partial<DSRConfig> {
  const merged = {
    ...base,
    ...updates,
    ...(base.opencode || updates.opencode
      ? {
          opencode: {
            ...(base.opencode ?? {}),
            ...(updates.opencode ?? {}),
          },
        }
      : {}),
    ...(base.codexAppServer || updates.codexAppServer
      ? {
          codexAppServer: {
            ...(base.codexAppServer ?? {}),
            ...(updates.codexAppServer ?? {}),
          },
        }
      : {}),
  };

  if (merged.codexAppServer?.env || base.codexAppServer?.env || updates.codexAppServer?.env) {
    merged.codexAppServer = {
      ...(merged.codexAppServer ?? {}),
      env: {
        ...(base.codexAppServer?.env ?? {}),
        ...(updates.codexAppServer?.env ?? {}),
      },
    };
  }

  return merged;
}

/**
 * Load a JSON file if it exists, return empty object otherwise
 * Throws if file exists but is corrupt/invalid JSON
 */
function loadJsonFile(path: string): Record<string, unknown> {
  // File doesn't exist - this is fine, return empty object
  if (!existsSync(path)) {
    return {};
  }

  // File exists - read and parse it
  try {
    const content = readFileSync(path, 'utf-8');
    return JSON.parse(content);
  } catch (err) {
    // Config file exists but is corrupt - this is a fatal error
    // Note: This function is called during config loading, before logger is configured
    // Using console.error is acceptable here as this is early initialization
    const errorMsg = `Corrupt config file at ${path}: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[DSR Config] ${errorMsg}`);
    throw new Error(errorMsg);
  }
}

/**
 * Get the project config directory path
 */
export function getProjectConfigDir(projectPath: string): string {
  return join(projectPath, PROJECT_CONFIG_SUBDIR);
}

/**
 * Get the system config directory path
 */
export function getSystemConfigDir(): string {
  return resolveSystemConfigDir();
}

/**
 * Load DSR configuration with hierarchy:
 * 1. Project-level config.json (chatId)
 * 2. System-level token.json (token)
 *
 * @param projectPath - Path to project root (optional)
 * @returns Merged configuration
 */
export function loadConfig(projectPath?: string): DSRConfig {
  let config: DSRConfig = { backend: DEFAULT_BACKEND };

  // Load system-level token (shared across all projects)
  const systemConfigDir = resolveSystemConfigDir();

  const systemTokenPath = join(systemConfigDir, 'token.json');
  const systemToken = normalizeConfig(loadJsonFile(systemTokenPath));
  config = mergeDSRConfig(config, systemToken);

  // Load system-level config (fallback chatId)
  const systemConfigPath = join(systemConfigDir, 'config.json');
  const systemConfig = normalizeConfig(loadJsonFile(systemConfigPath));
  config = mergeDSRConfig(config, systemConfig);

  // Load project-level config (overrides chatId)
  if (projectPath) {
    const projectConfigPath = join(projectPath, PROJECT_CONFIG_SUBDIR, 'config.json');
    const projectConfig = normalizeConfig(loadJsonFile(projectConfigPath));
    config = mergeDSRConfig(config, projectConfig);
  }

  config.backend = config.backend || DEFAULT_BACKEND;
  return config;
}

/**
 * Write/update project-level config.json (e.g. chatId)
 * Creates the config directory if it doesn't exist.
 *
 * @param projectPath - Path to project root
 * @param updates - Fields to merge into the existing config
 */
export function writeProjectConfig(projectPath: string, updates: Partial<DSRConfig>): void {
  const configDir = join(projectPath, PROJECT_CONFIG_SUBDIR);
  const configPath = join(configDir, 'config.json');

  // Ensure directory exists
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: SECURE_DIR_MODE });
  }

  // Load existing config and merge updates
  const existing = existsSync(configPath) ? loadJsonFile(configPath) : {};
  const merged = mergeDSRConfig(existing, updates);

  writeFileSync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

/**
 * Validate that required config is present
 */
export function validateConfig(config: DSRConfig): { valid: boolean; missing: string[] } {
  const missing: string[] = [];

  if (!config.token) {
    missing.push('token (run setup or add to ~/.config/opencode/deep-space-relay/token.json)');
  }
  if (!config.chatId) {
    missing.push('chatId (run setup or add to <project>/.opencode/deep-space-relay/config.json)');
  }

  return { valid: missing.length === 0, missing };
}

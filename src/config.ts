import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECURE_DIR_MODE } from './constants';

// ============================================================
// CONFIG LOADER
// ============================================================

// Config paths (uses hyphen for consistency with project name)
const SYSTEM_CONFIG_DIR = join(process.env.HOME || '', '.config/opencode/deep-space-relay');
const PROJECT_CONFIG_SUBDIR = '.opencode/deep-space-relay';

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

export interface DSRConfig {
  token?: string;
  chatId?: string;
  ipcToken?: string;
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
  return SYSTEM_CONFIG_DIR;
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
  const config: DSRConfig = {};

  // Load system-level token (shared across all projects)
  const systemTokenPath = join(SYSTEM_CONFIG_DIR, 'token.json');
  const systemToken = loadJsonFile(systemTokenPath);
  if (systemToken.token && typeof systemToken.token === 'string') {
    config.token = systemToken.token;
  }

  // Load system-level config (fallback chatId)
  const systemConfigPath = join(SYSTEM_CONFIG_DIR, 'config.json');
  const systemConfig = loadJsonFile(systemConfigPath);
  if (systemConfig.chatId && typeof systemConfig.chatId === 'string') {
    config.chatId = systemConfig.chatId;
  }
  if (systemConfig.ipcToken && typeof systemConfig.ipcToken === 'string') {
    config.ipcToken = systemConfig.ipcToken;
  }

  // Load project-level config (overrides chatId)
  if (projectPath) {
    const projectConfigPath = join(projectPath, PROJECT_CONFIG_SUBDIR, 'config.json');
    const projectConfig = loadJsonFile(projectConfigPath);
    if (projectConfig.chatId && typeof projectConfig.chatId === 'string') {
      config.chatId = projectConfig.chatId;
    }
    if (projectConfig.ipcToken && typeof projectConfig.ipcToken === 'string') {
      config.ipcToken = projectConfig.ipcToken;
    }
  }

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
  const merged = { ...existing, ...updates };

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

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { DSRConfig } from '../config';
import { log } from './logger';

/**
 * ConfigManager handles atomic and thread-safe configuration updates.
 */
export class ConfigManager {
  private projectConfigPath: string;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(projectConfigPath: string) {
    this.projectConfigPath = projectConfigPath;
  }

  /**
   * Update the project-level configuration atomically.
   *
   * @param updates - Partial configuration to merge
   */
  public async updateConfig(updates: Partial<DSRConfig>): Promise<void> {
    // Chain onto the write queue to ensure thread-safety
    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await this.executeAtomicUpdate(updates);
      } catch (err) {
        log(`[ConfigManager] Failed to update config: ${err}`, 'error');
        throw err;
      }
    });

    return this.writeQueue;
  }

  /**
   * Read the current configuration.
   */
  public async load(): Promise<DSRConfig> {
    if (!this.projectConfigPath || !existsSync(this.projectConfigPath)) {
      return {} as DSRConfig;
    }
    try {
      const content = readFileSync(this.projectConfigPath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      log(`[ConfigManager] Could not read existing config: ${err}`, 'warn');
      return {} as DSRConfig;
    }
  }

  /**
   * Internal method to perform the atomic update.
   */
  private async executeAtomicUpdate(updates: Partial<DSRConfig>): Promise<void> {
    if (!this.projectConfigPath) {
      throw new Error('Project config path not set');
    }

    // Ensure directory exists
    const dir = dirname(this.projectConfigPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Read existing config
    let currentConfig: Record<string, any> = {};
    if (existsSync(this.projectConfigPath)) {
      try {
        const content = readFileSync(this.projectConfigPath, 'utf-8');
        currentConfig = JSON.parse(content);
      } catch (err) {
        log(`[ConfigManager] Could not read existing config, starting fresh: ${err}`, 'warn');
      }
    }

    // Deep merge (simple version for DSRConfig)
    const newConfig = {
      ...currentConfig,
      ...updates,
    };

    // Atomic write strategy: write to .tmp and rename
    const tmpPath = `${this.projectConfigPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2)}`;

    try {
      writeFileSync(tmpPath, JSON.stringify(newConfig, null, 2), 'utf-8');
      renameSync(tmpPath, this.projectConfigPath);
    } catch (err) {
      // Cleanup tmp file if it exists and write/rename failed
      if (existsSync(tmpPath)) {
        try {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(tmpPath);
        } catch (cleanupErr) {
          // Best-effort cleanup during error handling, ignore if it fails
          log(`[ConfigManager] Could not cleanup tmp file: ${cleanupErr}`, 'debug');
        }
      }
      throw err;
    }
  }

  /**
   * Get the current project config path
   */
  public getConfigPath(): string {
    return this.projectConfigPath;
  }
}

/**
 * Get the default system config path.
 */
export function getDefaultConfigPath(): string {
  const HOME = process.env.HOME || '';
  return join(HOME, '.config/opencode/deep-space-relay/config.json');
}

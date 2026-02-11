import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ConfigManager } from '../src/daemon/config-manager';
import { writeProjectConfig, loadConfig } from '../src/config';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ConfigManager', () => {
  const testDir = join(tmpdir(), `dsr-test-${Date.now()}`);
  const configPath = join(testDir, 'config.json');

  beforeEach(() => {
    if (!existsSync(testDir)) {
      mkdirSync(testDir, { recursive: true });
    }
  });

  afterEach(() => {
    try {
      if (existsSync(configPath)) unlinkSync(configPath);
    } catch {}
  });

  it('should load config correctly', async () => {
    const initialConfig = { token: 'test-token', chatId: '123' };
    writeFileSync(configPath, JSON.stringify(initialConfig));

    const manager = new ConfigManager(configPath);
    const loaded = await manager.load();
    expect(loaded.token).toBe('test-token');
    expect(loaded.chatId).toBe('123');
  });

  it('should update config atomically and preserve existing values', async () => {
    const initialConfig = { token: 'secret-token', embedded: true };
    writeFileSync(configPath, JSON.stringify(initialConfig));

    const manager = new ConfigManager(configPath);
    await manager.updateConfig({ chatId: '456' });

    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(content.chatId).toBe('456');
    expect(content.token).toBe('secret-token');
    expect(content.embedded).toBe(true);
  });

  it('should handle concurrent updates safely', async () => {
    const manager = new ConfigManager(configPath);

    // Start multiple updates simultaneously
    await Promise.all([
      manager.updateConfig({ token: 'val1' }),
      manager.updateConfig({ chatId: 'val2' }),
      manager.updateConfig({ ipcToken: 'val3' }),
    ]);

    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(content.token).toBe('val1');
    expect(content.chatId).toBe('val2');
    expect(content.ipcToken).toBe('val3');
  });
});

describe('writeProjectConfig', () => {
  const projectDir = join(tmpdir(), `dsr-write-test-${Date.now()}`);
  const configSubdir = '.opencode/deep-space-relay';
  const configPath = join(projectDir, configSubdir, 'config.json');

  beforeEach(() => {
    if (!existsSync(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }
  });

  afterEach(() => {
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {}
  });

  it('should create config dir and write config.json', () => {
    writeProjectConfig(projectDir, { chatId: '-1001234567890' });

    expect(existsSync(configPath)).toBe(true);
    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(content.chatId).toBe('-1001234567890');
  });

  it('should merge with existing config', () => {
    // Write initial config
    writeProjectConfig(projectDir, { chatId: '-1001111111111' });

    // Update with new chatId
    writeProjectConfig(projectDir, { chatId: '-1002222222222' });

    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(content.chatId).toBe('-1002222222222');
  });

  it('should preserve existing fields when updating', () => {
    // Create directory and write initial config with extra fields
    const configDir = join(projectDir, configSubdir);
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ chatId: '-100111', customField: 'keep-me' }));

    // Update chatId only
    writeProjectConfig(projectDir, { chatId: '-100222' });

    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(content.chatId).toBe('-100222');
    expect(content.customField).toBe('keep-me');
  });

  it('should be readable by loadConfig', () => {
    writeProjectConfig(projectDir, { chatId: '-1009999999999' });

    const config = loadConfig(projectDir);
    expect(config.chatId).toBe('-1009999999999');
  });
});

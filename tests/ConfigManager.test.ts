import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ConfigManager } from '../src/daemon/config-manager';
import { writeFileSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
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
      manager.updateConfig({ field1: 'val1' }),
      manager.updateConfig({ field2: 'val2' }),
      manager.updateConfig({ field3: 'val3' }),
    ]);

    const content = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(content.field1).toBe('val1');
    expect(content.field2).toBe('val2');
    expect(content.field3).toBe('val3');
  });
});

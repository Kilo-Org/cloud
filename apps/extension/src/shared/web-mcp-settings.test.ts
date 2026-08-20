import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_WEB_MCP_SETTINGS,
  WEB_MCP_SETTINGS_STORAGE_KEY,
  loadWebMcpSettings,
  saveWebMcpSettings,
} from './web-mcp-settings';

const createStorage = () => {
  const values = new Map<string, unknown>();
  return {
    getItem: (key: string) => values.get(key),
    setItem: (key: string, value: unknown) => {
      values.set(key, value);
    },
    values,
  };
};

describe('web MCP settings storage', () => {
  it('defaults allowing WebMCP in safe mode to off', () => {
    expect(DEFAULT_WEB_MCP_SETTINGS).toStrictEqual({ allowWebMcpInSafeMode: false });
  });

  it('loads the default record when nothing is stored', async () => {
    const storage = createStorage();
    await expect(loadWebMcpSettings(storage)).resolves.toStrictEqual(DEFAULT_WEB_MCP_SETTINGS);
  });

  it('loads the default record for a malformed value', async () => {
    const storage = createStorage();
    storage.values.set(WEB_MCP_SETTINGS_STORAGE_KEY, 'not-an-object');
    await expect(loadWebMcpSettings(storage)).resolves.toStrictEqual(DEFAULT_WEB_MCP_SETTINGS);

    storage.values.set(WEB_MCP_SETTINGS_STORAGE_KEY, { allowWebMcpInSafeMode: 'yes' });
    await expect(loadWebMcpSettings(storage)).resolves.toStrictEqual(DEFAULT_WEB_MCP_SETTINGS);
  });

  it('round-trips the flag', async () => {
    const storage = createStorage();
    await saveWebMcpSettings(storage, { allowWebMcpInSafeMode: true });
    await expect(loadWebMcpSettings(storage)).resolves.toStrictEqual({
      allowWebMcpInSafeMode: true,
    });

    await saveWebMcpSettings(storage, { allowWebMcpInSafeMode: false });
    await expect(loadWebMcpSettings(storage)).resolves.toStrictEqual(DEFAULT_WEB_MCP_SETTINGS);
  });

  it('rejects when the storage read fails', async () => {
    const storage = {
      getItem: () => {
        throw new Error('read failed');
      },
      setItem: () => {
        throw new Error('write failed');
      },
    };
    await expect(loadWebMcpSettings(storage)).rejects.toThrow('read failed');
  });

  it('rejects when the storage read rejects', async () => {
    const storage = {
      getItem: vi.fn().mockRejectedValue(new Error('read failed')),
      setItem: vi.fn().mockRejectedValue(new Error('write failed')),
    };
    await expect(loadWebMcpSettings(storage)).rejects.toThrow('read failed');
  });
});

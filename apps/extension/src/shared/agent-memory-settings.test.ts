import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_SETTINGS_STORAGE_KEY,
  loadMemorySettings,
  saveMemorySettings,
} from './agent-memory-settings';

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

describe('memory settings storage', () => {
  it('defaults auto-approve of memory saves to off', () => {
    expect(DEFAULT_MEMORY_SETTINGS).toStrictEqual({ autoApproveMemorySaves: false });
  });

  it('loads the default record when nothing is stored', async () => {
    const storage = createStorage();
    await expect(loadMemorySettings(storage)).resolves.toStrictEqual(DEFAULT_MEMORY_SETTINGS);
  });

  it('loads the default record for a malformed value', async () => {
    const storage = createStorage();
    storage.values.set(MEMORY_SETTINGS_STORAGE_KEY, 'not-an-object');
    await expect(loadMemorySettings(storage)).resolves.toStrictEqual(DEFAULT_MEMORY_SETTINGS);

    storage.values.set(MEMORY_SETTINGS_STORAGE_KEY, { autoApproveMemorySaves: 'yes' });
    await expect(loadMemorySettings(storage)).resolves.toStrictEqual(DEFAULT_MEMORY_SETTINGS);
  });

  it('round-trips the flag', async () => {
    const storage = createStorage();
    await saveMemorySettings(storage, { autoApproveMemorySaves: true });
    await expect(loadMemorySettings(storage)).resolves.toStrictEqual({
      autoApproveMemorySaves: true,
    });

    await saveMemorySettings(storage, { autoApproveMemorySaves: false });
    await expect(loadMemorySettings(storage)).resolves.toStrictEqual(DEFAULT_MEMORY_SETTINGS);
  });
});

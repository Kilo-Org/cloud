import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const entry = {
  itemId: 'part-1',
  language: 'de',
  modelId: 'kilo-auto/small',
  text: 'Ran tests',
  translation: 'Tests ausgeführt',
  storedAt: 1_700_000_000_000,
};

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@/lib/persist/tool-summary-translation-cache');
});

describe('translation store module loading', () => {
  it.each(['read', 'write'] as const)('retries a failed import on the next %s', async operation => {
    vi.doMock('@/lib/persist/tool-summary-translation-cache', () => {
      throw new Error('transient module load failure');
    });
    const { readStoredTranslations, persistTranslation } =
      await import('./tool-summary-translation-store');
    await expect(readStoredTranslations()).resolves.toEqual([]);

    const read = vi.fn().mockResolvedValue([entry]);
    const write = vi.fn().mockResolvedValue(undefined);
    // The module is available again, without reloading the bridge's memo.
    vi.doMock('@/lib/persist/tool-summary-translation-cache', () => ({
      readToolSummaryTranslations: read,
      writeToolSummaryTranslation: write,
    }));

    if (operation === 'read') {
      await expect(readStoredTranslations()).resolves.toEqual([entry]);
      expect(read).toHaveBeenCalledTimes(1);
    } else {
      await expect(persistTranslation(entry)).resolves.toBeUndefined();
      expect(write).toHaveBeenCalledWith(entry, expect.any(Number));
    }
  });
});

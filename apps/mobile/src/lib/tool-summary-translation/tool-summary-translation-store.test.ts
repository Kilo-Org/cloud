import { afterEach, expect, it, vi } from 'vitest';

import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { type CachedToolSummaryTranslation } from '@/lib/persist/tool-summary-translation-cache';

const entry: CachedToolSummaryTranslation = {
  itemId: 'part-1',
  language: 'de',
  modelId: 'kilo-auto/small',
  text: 'Ran tests',
  translation: 'Tests ausgeführt',
  storedAt: 1_700_000_000_000,
};

afterEach(() => {
  vi.doUnmock('@/lib/persist/tool-summary-translation-cache');
  vi.resetModules();
});

it.each(['read', 'write'] as const)('retries a failed store import after a %s', async operation => {
  vi.resetModules();
  vi.doMock('@/lib/persist/tool-summary-translation-cache', () => {
    throw new Error('module temporarily unavailable');
  });
  const bridge = await import('./tool-summary-translation-store');
  await (operation === 'read'
    ? expect(bridge.readStoredTranslations()).resolves.toEqual([])
    : expect(bridge.persistTranslation(entry)).resolves.toBeUndefined());

  const read = vi.fn().mockResolvedValue([entry]);
  const write = vi.fn().mockResolvedValue(undefined);
  vi.doMock('@/lib/persist/tool-summary-translation-cache', () => ({
    readToolSummaryTranslations: read,
    writeToolSummaryTranslation: write,
  }));

  await expect(bridge.readStoredTranslations()).resolves.toEqual([entry]);
  await bridge.persistTranslation(entry);
  expect(read).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith(entry, currentAuthEpoch());
});

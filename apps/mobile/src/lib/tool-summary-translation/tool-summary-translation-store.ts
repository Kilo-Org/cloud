import {
  type CachedToolSummaryTranslation,
  type readToolSummaryTranslations,
  type writeToolSummaryTranslation,
} from '@/lib/persist/tool-summary-translation-cache';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';

/**
 * The encrypted-KV bridge for tool-summary translation. The store is loaded by
 * one memoized dynamic import, so the pure runtime stays free of native imports
 * and hydration and persistence share a single load.
 *
 * Every failure is swallowed: the store is a warm-start optimization, never a
 * source of truth, so it must never affect the transcript path.
 */

type CacheStore = {
  readToolSummaryTranslations: typeof readToolSummaryTranslations;
  writeToolSummaryTranslation: typeof writeToolSummaryTranslation;
};

let storePromise: Promise<CacheStore> | null = null;

async function loadStore(): Promise<CacheStore> {
  const pending = (storePromise ??= import('@/lib/persist/tool-summary-translation-cache'));
  try {
    return await pending;
  } catch (error) {
    if (storePromise === pending) {
      storePromise = null;
    }
    throw error;
  }
}

/** Reads every stored translation; a store failure reads as no entries. */
export async function readStoredTranslations(): Promise<CachedToolSummaryTranslation[]> {
  try {
    const { readToolSummaryTranslations: read } = await loadStore();
    return await read();
  } catch {
    return [];
  }
}

/**
 * Fire-and-forget write of one resolved translation; never throws. The auth
 * epoch is captured at dispatch — before the store module loads — and handed
 * to the write, so a write that lands after a sign-out or direct-switch scope
 * clear removes itself instead of recreating the previous account's entry.
 */
export async function persistTranslation(entry: CachedToolSummaryTranslation): Promise<void> {
  const epoch = currentAuthEpoch();
  try {
    const { writeToolSummaryTranslation: write } = await loadStore();
    await write(entry, epoch);
  } catch {
    // A cache write failure is not a transcript failure.
  }
}

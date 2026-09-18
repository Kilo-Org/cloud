import {
  type CachedToolSummaryTranslation,
  type clearToolSummaryTranslationsForSignOut,
  type readToolSummaryTranslations,
  type writeToolSummaryTranslation,
} from '@/lib/persist/tool-summary-translation-cache';

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
  clearToolSummaryTranslationsForSignOut: typeof clearToolSummaryTranslationsForSignOut;
};

let storePromise: Promise<CacheStore> | null = null;

// eslint-disable-next-line typescript-eslint/promise-function-async -- memoizes the dynamic import; there is nothing to await
function loadStore(): Promise<CacheStore> {
  storePromise ??= import('@/lib/persist/tool-summary-translation-cache');
  return storePromise;
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

/** Fire-and-forget write of one resolved translation; never throws. */
export async function persistTranslation(entry: CachedToolSummaryTranslation): Promise<void> {
  try {
    const { writeToolSummaryTranslation: write } = await loadStore();
    await write(entry);
  } catch {
    // A cache write failure is not a transcript failure.
  }
}

/**
 * Clears every stored translation; never throws. Used to re-clear the durable
 * scope once a pre-reset write has settled, so a signed-out account's tool text
 * cannot survive the sign-out that abandoned its write.
 */
export async function clearStoredTranslations(): Promise<void> {
  try {
    const { clearToolSummaryTranslationsForSignOut: clear } = await loadStore();
    await clear();
  } catch {
    // A cache clear failure is a warm-start cost, not a transcript failure.
  }
}

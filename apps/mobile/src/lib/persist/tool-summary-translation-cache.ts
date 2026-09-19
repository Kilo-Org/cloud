import { z } from 'zod';

import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import * as encryptedKv from '@/lib/persist/encrypted-kv';
import { TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE } from '@/lib/storage-keys';

/**
 * Offline cache of translated tool summaries, keyed by the item's persistent id
 * so a translation survives an app restart and reads with no request at all.
 *
 * One encrypted-KV scope ({@link TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE}) holds
 * one JSON entry per translation under
 * `tt:<language>:<modelId>:<itemId>:<text>`. The scope holds nothing else, so
 * the cap counts every entry and needs no key-prefix filter — unlike
 * `session-transcript-cache.ts`, whose `transcript:` keys share the read-cache
 * scope with an unrelated blob.
 * {@link encryptedKv.listEntries} is oldest-first by `updated_at`, so a write
 * past {@link TOOL_SUMMARY_TRANSLATION_CACHE_CAP} deletes the oldest entries
 * first.
 *
 * Expiry is the caller's decision: {@link readToolSummaryTranslations} returns
 * each entry's `storedAt`, and this module applies no TTL, so the runtime owns
 * the "a couple of days" rule.
 *
 * Every failure is swallowed — this is a warm-start optimization, never a
 * source of truth, so it must never affect the transcript path.
 */

/** At most this many translations are kept; the rest are evicted oldest-first. */
export const TOOL_SUMMARY_TRANSLATION_CACHE_CAP = 200;

/**
 * Longest sign-out waits for the scope clear. The clear is a native module
 * call, and a clear that never answers must not hold sign-out teardown — the
 * caller awaits this inside its `Promise.allSettled` batch, so a hanging
 * operation would otherwise stop `queryClient.clear()` and `setToken`. Past
 * this the clear is treated as hung and the caller continues; a late clear is
 * harmless, so the operation itself is not cancelled.
 */
export const TOOL_SUMMARY_TRANSLATION_SCOPE_CLEAR_TIMEOUT_MS = 1000;

const ITEM_KEY_PREFIX = 'tt:';

export type CachedToolSummaryTranslation = {
  itemId: string;
  language: string;
  modelId: string;
  text: string;
  translation: string;
  storedAt: number;
};

// Decode at the I/O boundary: the KV is encrypted but still untrusted storage
// after a restore. All six fields are required, and `z.number()` rejects NaN
// and Infinity in Zod 4, so `storedAt` is always a finite number.
const cachedToolSummaryTranslationSchema = z.object({
  itemId: z.string(),
  language: z.string(),
  modelId: z.string(),
  text: z.string(),
  translation: z.string(),
  storedAt: z.number(),
});

/**
 * The stored key: the same identity the runtime keys its in-memory cache by —
 * the part id plus the source string it was made from, under one language and
 * model. The source text is load-bearing: without it a late write for a
 * superseded text replaces the entry the row now renders, and a cold-start
 * offline row misses its translation. The item id is encoded so its segment
 * cannot be split by a colon; the text stays last, so it may keep its readable
 * form.
 */
// eslint-disable-next-line max-params -- the language, model, part id and source text form the key
function translationItemKey(
  language: string,
  modelId: string,
  itemId: string,
  text: string
): string {
  return `${ITEM_KEY_PREFIX}${language}:${modelId}:${encodeURIComponent(itemId)}:${text}`;
}

/** Parses one stored value; null for a missing, unparsable, or malformed entry. */
function parseEntry(raw: string | null): CachedToolSummaryTranslation | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = cachedToolSummaryTranslationSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Reads every cached translation oldest-first, dropping entries that are
 * unknown or malformed. A missing scope, a KV failure, or a parse failure
 * returns `[]`. Never throws.
 */
export async function readToolSummaryTranslations(): Promise<CachedToolSummaryTranslation[]> {
  try {
    const values = await encryptedKv.listValues(TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE);
    const parsed = values.map(value => parseEntry(value));
    return parsed.filter((entry): entry is CachedToolSummaryTranslation => entry !== null);
  } catch {
    // Any failure (missing scope, KV unavailable, parse error) is a cache miss.
    return [];
  }
}

/**
 * Writes one translated summary under
 * `tt:<language>:<modelId>:<itemId>:<text>`, then evicts the oldest entries
 * beyond {@link TOOL_SUMMARY_TRANSLATION_CACHE_CAP}. An entry that fails
 * validation is dropped instead of written. Never throws.
 *
 * `epoch` is the auth epoch captured when the write was dispatched (see
 * `persistTranslation`). Sign-out and a direct account switch both advance the
 * epoch and clear this scope, and a write the caller's bounded drain already
 * abandoned can still land afterwards; the entry is therefore removed again
 * once it settles when the epoch moved, so a late write can never recreate the
 * previous account's tool text after the scope was cleared. A write that lands
 * under a newer account's epoch is left alone: it belongs to that account, and
 * the removal only drops the value this write stored, so a newer entry the same
 * key now holds is never deleted.
 */
export async function writeToolSummaryTranslation(
  entry: CachedToolSummaryTranslation,
  epoch: number = currentAuthEpoch()
): Promise<void> {
  const parsed = cachedToolSummaryTranslationSchema.safeParse(entry);
  if (!parsed.success) {
    return;
  }
  const itemKey = translationItemKey(
    parsed.data.language,
    parsed.data.modelId,
    parsed.data.itemId,
    parsed.data.text
  );
  const serialized = JSON.stringify(parsed.data);
  try {
    // The transition already cleared the scope before this write could start:
    // committing would recreate the entry the clear removed.
    if (epoch !== currentAuthEpoch()) {
      return;
    }
    await encryptedKv.setItem(TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE, itemKey, serialized);
    if (epoch !== currentAuthEpoch()) {
      // The scope was cleared while this write was in flight. Remove the entry
      // the clear could not have seen, so the durable scope stays empty — but
      // only while it is still this write's value. The key names a
      // server-issued part id, so a later sign-in that reopens the same part
      // writes the same key; if such a write under the current epoch committed
      // while this one was unsettled, the stored value is the newer account's
      // entry and removing it would delete valid data. The compare happens
      // inside one conditional delete, so a newer same-key write that lands
      // between the epoch check and the removal is never deleted either.
      await encryptedKv.removeItemIfValue(
        TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE,
        itemKey,
        serialized
      );
      return;
    }
    await evictOldestBeyondCap();
  } catch {
    // Best effort: a cache write failure never affects the transcript path.
  }
}

/**
 * A scope clear that never rejects: it is raced against the sign-out bound, so
 * a late rejection of the losing clear must not escape as an unhandled
 * rejection. The clear keeps running past the bound; a late clear is harmless.
 */
async function clearScopeBestEffort(): Promise<void> {
  try {
    await encryptedKv.clearScope(TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE);
  } catch {
    // Best effort: sign-out continues; the orphaned blob is re-fetched away.
  }
}

/** Initial value before the promise executor installs the real resolver. */
const noopVoidResolution = (): void => undefined;

/**
 * Sign-out cleanup: drop the whole translation scope.
 *
 * The stored entries carry the signed-out account's tool text (file paths,
 * bash commands, descriptions), and a translation is refetchable — it is a
 * cache row, not a draft ("cache rows are deleted on sign-out, drafts are
 * not", `drafts.ts`). So the previous account's tool content must not survive
 * the teardown. This mirrors {@link clearSessionAttentionForSignOut}, which
 * clears its own scope in the same sign-out batch.
 *
 * The runtime's in-memory cache needs no reset here and this function does not
 * reach it: its entries are keyed by the server-issued `ToolPart.id`, unique
 * per part and owned by exactly one account's session, so a stale in-memory
 * entry can never match the next account's row — and the map dies with the
 * process anyway.
 *
 * Best effort: a storage failure is swallowed so it can never abort sign-out.
 * A stale blob only costs a future cache hit; it is never a source of truth.
 * The clear is also bounded ({@link
 * TOOL_SUMMARY_TRANSLATION_SCOPE_CLEAR_TIMEOUT_MS}): a native clear that never
 * answers resolves the caller after the bound instead of holding sign-out
 * teardown.
 */
export async function clearToolSummaryTranslationsForSignOut(): Promise<void> {
  let resolveTimeout: () => void = noopVoidResolution;
  const timeout = new Promise<'timeout'>(resolve => {
    resolveTimeout = () => {
      resolve('timeout');
    };
  });
  const timeoutId = setTimeout(resolveTimeout, TOOL_SUMMARY_TRANSLATION_SCOPE_CLEAR_TIMEOUT_MS);
  try {
    await Promise.race([clearScopeBestEffort(), timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Keeps at most {@link TOOL_SUMMARY_TRANSLATION_CACHE_CAP} entries. This scope
 * holds nothing but translations, so every listed entry counts and no key
 * prefix filter is needed. `listEntries` is oldest-first by `updated_at`, so
 * the oldest translations go first.
 */
async function evictOldestBeyondCap(): Promise<void> {
  const entries = await encryptedKv.listEntries(TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE);
  const overflow = entries.length - TOOL_SUMMARY_TRANSLATION_CACHE_CAP;
  if (overflow <= 0) {
    return;
  }
  await Promise.all(
    entries.slice(0, overflow).map(async entry => {
      await encryptedKv.removeItem(TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE, entry.k);
    })
  );
}

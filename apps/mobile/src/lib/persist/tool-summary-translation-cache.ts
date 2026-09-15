import { z } from 'zod';

import * as encryptedKv from '@/lib/persist/encrypted-kv';
import { TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE } from '@/lib/storage-keys';

/**
 * Offline cache of translated tool summaries, keyed by the item's persistent id
 * so a translation survives an app restart and reads with no request at all.
 *
 * One encrypted-KV scope ({@link TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE}) holds
 * one JSON entry per translation under `tt:<language>:<modelId>:<itemId>`. The
 * scope holds nothing else, so the cap counts every entry and needs no
 * key-prefix filter — unlike `session-transcript-cache.ts`, whose `transcript:`
 * keys share the read-cache scope with an unrelated blob.
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

function translationItemKey(language: string, modelId: string, itemId: string): string {
  return `${ITEM_KEY_PREFIX}${language}:${modelId}:${itemId}`;
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
    const entries = await encryptedKv.listEntries(TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE);
    const parsed = await Promise.all(
      entries.map(async entry => {
        const raw = await encryptedKv.getItem(TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE, entry.k);
        return parseEntry(raw);
      })
    );
    return parsed.filter((entry): entry is CachedToolSummaryTranslation => entry !== null);
  } catch {
    // Any failure (missing scope, KV unavailable, parse error) is a cache miss.
    return [];
  }
}

/**
 * Writes one translated summary under `tt:<language>:<modelId>:<itemId>`, then
 * evicts the oldest entries beyond {@link TOOL_SUMMARY_TRANSLATION_CACHE_CAP}.
 * An entry that fails validation is dropped instead of written. Never throws.
 */
export async function writeToolSummaryTranslation(
  entry: CachedToolSummaryTranslation
): Promise<void> {
  const parsed = cachedToolSummaryTranslationSchema.safeParse(entry);
  if (!parsed.success) {
    return;
  }
  try {
    await encryptedKv.setItem(
      TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE,
      translationItemKey(parsed.data.language, parsed.data.modelId, parsed.data.itemId),
      JSON.stringify(parsed.data)
    );
    await evictOldestBeyondCap();
  } catch {
    // Best effort: a cache write failure never affects the transcript path.
  }
}

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
 */
export async function clearToolSummaryTranslationsForSignOut(): Promise<void> {
  try {
    await encryptedKv.clearScope(TOOL_SUMMARY_TRANSLATION_CACHE_SCOPE);
  } catch {
    // Best effort: sign-out continues; the orphaned blob is re-fetched away.
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

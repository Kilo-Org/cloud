import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

import { deleteAccountMetadata, writeAccountMetadata } from '@/lib/auth/account-metadata-write';
import { PR_REVIEW_VIEWED_KEY } from '@/lib/storage-keys';

type ViewedFileEntry = {
  headSha: string;
  viewedPaths: string[];
};

type ViewedFileMap = Record<string, ViewedFileEntry>;

const viewedFileEntrySchema = z.object({
  headSha: z.string(),
  viewedPaths: z.array(z.string()),
});
const rawViewedFileMapSchema = z.record(z.string(), z.unknown());

const VIEWED_FILES_PR_LIMIT = 20;

// Process-lifetime cache of the parsed map. `readMap` returns it when set so a
// second read after a toggle (or any other read) does not re-read and re-parse
// SecureStore. `clearViewedFiles` resets it so sign-out and account change drop
// the private content (auth-context.tsx calls it).
let cachedMap: ViewedFileMap | null = null;

// Monotonic write/clear generation. `readMap` captures it before the
// SecureStore read and only publishes the parsed map when it is unchanged, so
// a first read that started while the cache was empty cannot overwrite a write
// or refill the cache after a clear.
let generation = 0;

type ViewedFilePrRef = {
  owner: string;
  repo: string;
  number: number;
};

function viewedFilesKey(ref: ViewedFilePrRef): string {
  return `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;
}

function parseMap(raw: string | null): ViewedFileMap {
  if (raw == null || raw.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const shape = rawViewedFileMapSchema.safeParse(parsed);
    if (!shape.success) {
      return {};
    }
    // Drop any structurally invalid entry rather than trusting a cast, so
    // one corrupt record can't make getViewedFiles return a non-array or
    // make toggleViewedFile throw on `.includes`.
    return Object.fromEntries(
      Object.entries(shape.data).flatMap<[string, ViewedFileEntry]>(([key, value]) => {
        const entry = viewedFileEntrySchema.safeParse(value);
        return entry.success ? [[key, entry.data]] : [];
      })
    );
  } catch {
    return {};
  }
}

function toJsonString(map: ViewedFileMap): string {
  return JSON.stringify(map);
}

function computeNextViewedPaths(
  existing: ViewedFileEntry | undefined,
  headSha: string,
  path: string
): string[] {
  if (!existing || existing.headSha !== headSha) {
    // Fresh PR or SHA changed: start a clean set with this one path.
    return [path];
  }
  if (existing.viewedPaths.includes(path)) {
    return existing.viewedPaths.filter(p => p !== path);
  }
  return [...existing.viewedPaths, path];
}

async function readMap(): Promise<ViewedFileMap> {
  const cached = cachedMap;
  if (cached !== null) {
    return cached;
  }
  const gen = generation;
  const raw = await SecureStore.getItemAsync(PR_REVIEW_VIEWED_KEY);
  if (gen !== generation) {
    // A write or clear happened while this read was in flight. A write
    // publishes the fresh map to `cachedMap`; a clear nulls it. Return the
    // authoritative current state, never the stale parse.
    return cachedMap ?? {};
  }
  const parsed = parseMap(raw);
  cachedMap = parsed;
  return parsed;
}

export async function getViewedFiles(ref: ViewedFilePrRef, headSha: string): Promise<string[]> {
  const map = await readMap();
  const entry = map[viewedFilesKey(ref)];
  if (!entry || entry.headSha !== headSha) {
    return [];
  }
  return entry.viewedPaths;
}

/**
 * Toggle a single file path in the viewed set for a PR. The record is keyed
 * by `owner/repo#number`; when the incoming `headSha` differs from the
 * stored one the viewedPaths are reset (file paths from a previous SHA are
 * almost certainly stale and shouldn't be re-marked). The map itself is
 * LRU-trimmed to VIEWED_FILES_PR_LIMIT PRs by most-recently-touched.
 */
type ToggleViewedFileInput = ViewedFilePrRef & {
  headSha: string;
  path: string;
};

export async function toggleViewedFile(input: ToggleViewedFileInput): Promise<void> {
  const { headSha, path } = input;
  await writeAccountMetadata(PR_REVIEW_VIEWED_KEY, async () => {
    const map = await readMap();
    const key = viewedFilesKey(input);
    const existing = map[key];

    const nextViewedPaths = computeNextViewedPaths(existing, headSha, path);

    const nextEntry: ViewedFileEntry = { headSha, viewedPaths: nextViewedPaths };

    // Re-insert the touched PR at the end of insertion order so we can
    // trim oldest-first by Object.keys order.
    const reordered: ViewedFileMap = {};
    for (const [existingKey, value] of Object.entries(map)) {
      if (existingKey !== key) {
        reordered[existingKey] = value;
      }
    }
    reordered[key] = nextEntry;

    const trimmedEntries = Object.entries(reordered).slice(-VIEWED_FILES_PR_LIMIT);
    const trimmed: ViewedFileMap = {};
    for (const [trimmedKey, value] of trimmedEntries) {
      trimmed[trimmedKey] = value;
    }
    await SecureStore.setItemAsync(PR_REVIEW_VIEWED_KEY, toJsonString(trimmed));
    cachedMap = trimmed;
    generation += 1;
  });
}

export async function clearViewedFiles(): Promise<void> {
  // Fence first: a concurrent getViewedFiles must not return the prior
  // account's paths (or publish a SecureStore read of the not-yet-deleted
  // value) while deletion is in flight.
  cachedMap = {};
  generation += 1;
  await deleteAccountMetadata(PR_REVIEW_VIEWED_KEY);
}

/**
 * For tests: drop the process-lifetime cache so a test that swaps the fake
 * SecureStore gets a fresh read. Mirrors `clearHighlightCacheForTests`.
 */
export function resetViewedFilesCacheForTests(): void {
  cachedMap = null;
}

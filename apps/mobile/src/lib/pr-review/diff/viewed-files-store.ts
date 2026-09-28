// The PR-review viewed-files store: one process-wide source of truth for the
// per-PR viewed set, read through `useSyncExternalStore`.
//
// The durable set lives in SecureStore (`viewed-files.ts`) behind a
// process-lifetime parse cache. Before this store, every mounted consumer (the
// Files list and the file-navigator sheet over it) kept its own `useState`
// copy plus its own loading flag and re-read the durable map after any toggle
// through a module-level notifier. The state already lived outside React, so
// the store is now the only reader: `usePrReviewViewedFiles` subscribes to it
// and the toggle path publishes an optimistic snapshot before the durable
// write, then re-reads every open key so the two surfaces agree.
//
// Identity: a snapshot is keyed by `viewedFilesKey(ref)` (provider-scoped,
// identity rule 17) plus the head SHA — the same keying the durable map uses.
//
// Lifetime: an entry exists only while at least one listener is subscribed, so
// the first listener starts the read (`PENDING`, then the resolved set) and the
// last unsubscribe drops it. A remount re-reads and shows `isLoading: true`
// again, exactly like the old `useState` lifetime.

import {
  getViewedFiles,
  toggleViewedFile,
  viewedFilesKey,
  type ViewedFilesRef,
} from '@/lib/pr-review/viewed-files';

/** The immutable view of one PR's viewed set that the hook renders. */
export type ViewedFilesSnapshot = Readonly<{
  paths: readonly string[];
  isLoading: boolean;
}>;

// Returned for a key with no entry. `useSyncExternalStore` requires a
// referentially stable snapshot (a fresh object each read would re-render
// forever), so `getViewedFilesSnapshot` never allocates — it hands back this
// frozen constant until the key resolves its first read.
const PENDING: ViewedFilesSnapshot = Object.freeze({
  paths: Object.freeze([] as string[]),
  isLoading: true,
});

type ViewedFilesEntry = {
  ref: ViewedFilesRef;
  headSha: string;
  snapshot: ViewedFilesSnapshot;
  listeners: Set<() => void>;
  /** The first read for this entry has been started. */
  started: boolean;
};

const entries = new Map<string, ViewedFilesEntry>();

function storeKey(ref: ViewedFilesRef, headSha: string): string {
  return `${viewedFilesKey(ref)}|${headSha}`;
}

export function getViewedFilesSnapshot(ref: ViewedFilesRef, headSha: string): ViewedFilesSnapshot {
  return entries.get(storeKey(ref, headSha))?.snapshot ?? PENDING;
}

function publish(entry: ViewedFilesEntry, snapshot: ViewedFilesSnapshot): void {
  entry.snapshot = snapshot;
  for (const listener of entry.listeners) {
    listener();
  }
}

/** Read one entry's durable set; a failed read renders as an empty viewed set. */
async function readPaths(entry: ViewedFilesEntry): Promise<readonly string[]> {
  try {
    return await getViewedFiles(entry.ref, entry.headSha);
  } catch {
    // The pre-store `catch`: a rejected read shows exactly the empty set.
    return [];
  }
}

async function loadViewedFiles(key: string, entry: ViewedFilesEntry): Promise<void> {
  const paths = await readPaths(entry);
  // The entry can be dropped (last listener removed) or replaced (remount
  // subscribed again) while the read is in flight; a late result must never
  // serve the entry that now owns the key.
  if (entries.get(key) !== entry) {
    return;
  }
  publish(entry, Object.freeze({ paths: Object.freeze([...paths]), isLoading: false }));
}

/**
 * Subscribe to one PR's viewed set. The first listener inserts the entry with
 * `PENDING` and starts the durable read; the last unsubscribe drops the entry.
 * Never notifies synchronously — React subscribes during commit.
 */
export function subscribeViewedFiles(
  ref: ViewedFilesRef,
  headSha: string,
  listener: () => void
): () => void {
  const key = storeKey(ref, headSha);
  let entry = entries.get(key);
  if (!entry) {
    entry = { ref, headSha, snapshot: PENDING, listeners: new Set(), started: false };
    entries.set(key, entry);
  }
  entry.listeners.add(listener);
  if (!entry.started) {
    entry.started = true;
    void loadViewedFiles(key, entry);
  }
  return () => {
    const current = entries.get(key);
    if (!current) {
      return;
    }
    current.listeners.delete(listener);
    if (current.listeners.size === 0) {
      entries.delete(key);
    }
  };
}

/** Re-read the durable set for one open key, if anything is subscribed to it. */
export async function revalidateViewedFiles(ref: ViewedFilesRef, headSha: string): Promise<void> {
  const key = storeKey(ref, headSha);
  const entry = entries.get(key);
  if (!entry) {
    return;
  }
  await loadViewedFiles(key, entry);
}

/** Re-read every open key, so all mounted consumers of any PR catch up. */
export function revalidateAllViewedFiles(): void {
  for (const [key, entry] of entries) {
    void loadViewedFiles(key, entry);
  }
}

/**
 * Toggle one path: publish the flipped set immediately (optimistic — the
 * durable write is SecureStore, and the UI must not wait for it), then write
 * it and re-read every open key so the navigator sheet and the diff list
 * behind it agree (the pre-store `notifyViewedChange`).
 */
export async function applyViewedFilesToggle(
  ref: ViewedFilesRef,
  headSha: string,
  path: string
): Promise<void> {
  const entry = entries.get(storeKey(ref, headSha));
  if (entry) {
    const current = entry.snapshot.paths;
    const nextPaths = current.includes(path)
      ? current.filter(existing => existing !== path)
      : [...current, path];
    publish(
      entry,
      Object.freeze({ paths: Object.freeze(nextPaths), isLoading: entry.snapshot.isLoading })
    );
  }
  await toggleViewedFile({ ...ref, headSha, path });
  revalidateAllViewedFiles();
}

/** For tests: drop every entry so a swapped fake store gets a fresh read. */
export function resetViewedFilesStoreForTests(): void {
  entries.clear();
}

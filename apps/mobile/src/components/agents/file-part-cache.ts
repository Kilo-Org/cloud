import { useSyncExternalStore } from 'react';

/** A captured FilePart URL, stored in memory only. No bytes are downloaded. */
export type FilePartCacheEntry = {
  url: string;
  mime: string;
  filename?: string;
};

/** Reactive map of partId → captured FilePart entry. First write wins. */
const entriesByPartId = new Map<string, FilePartCacheEntry>();
const listeners = new Set<() => void>();
/** Bumped on every map mutation so useSyncExternalStore sees a new snapshot. */
let entriesVersion = 0;

function emitChange(): void {
  entriesVersion += 1;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersionSnapshot(): number {
  return entriesVersion;
}

/**
 * Record a captured FilePart URL. Stores the URL string only — never downloads
 * bytes. First write wins: a later call for the same `partId` is a no-op.
 */
export function cacheFilePart(
  partId: string,
  payload: Readonly<{ url: string; mime: string; filename?: string }>
): void {
  if (entriesByPartId.has(partId)) {
    return;
  }
  entriesByPartId.set(partId, {
    url: payload.url,
    mime: payload.mime,
    ...(payload.filename ? { filename: payload.filename } : {}),
  });
  emitChange();
}

/** Synchronous lookup used by the hook and by tests. */
export function getFilePartCacheEntry(partId: string): FilePartCacheEntry | undefined {
  return entriesByPartId.get(partId);
}

/**
 * Reactive lookup of a captured FilePart entry. Returns `undefined` until a
 * write is recorded for `partId`.
 */
export function useFilePartCache(partId: string): FilePartCacheEntry | undefined {
  useSyncExternalStore(subscribe, getVersionSnapshot, getVersionSnapshot);
  return entriesByPartId.get(partId);
}

/** True only for `http:`, `https:`, and `data:` URLs. */
export function isUsableFilePartUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:');
}

/** Test-only: clear in-memory state between cases. */
export function __resetFilePartCacheForTests(): void {
  entriesByPartId.clear();
  emitChange();
}

import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

import { getSafeCacheFilename } from '@/lib/share-remote-file';

import { stripDataUrlBase64Prefix } from './tool-card-image-cache';

const CACHE_DIR_NAME = 'session-file-parts';

/** A captured FilePart URL. `data:` URLs are written to disk and stored as a
 *  small `file://` URI; `http(s)` URLs are stored as-is. No bytes are
 *  downloaded. */
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
 * Resolve the URL to store for a captured FilePart. A `data:` URL is written
 * to disk and stored as a `file://` URI; an `http(s)` URL is stored as-is. On
 * any decode or write failure the raw URL is stored instead. Never throws.
 */
function resolveCacheUrl(
  partId: string,
  payload: Readonly<{ url: string; mime: string; filename?: string }>
): string {
  if (!payload.url.startsWith('data:')) {
    return payload.url;
  }
  const stripped = stripDataUrlBase64Prefix(payload.url, payload.mime);
  if (stripped === undefined) {
    return payload.url;
  }
  try {
    const directory = new Directory(Paths.cache, CACHE_DIR_NAME);
    directory.create({ idempotent: true, intermediates: true });
    const file = new File(
      directory,
      getSafeCacheFilename({ id: partId, filename: payload.filename ?? 'file' })
    );
    file.write(stripped, { encoding: 'base64' });
    return file.uri;
  } catch {
    return payload.url;
  }
}

/**
 * Record a captured FilePart URL. A `data:` URL is written to disk and stored
 * as a `file://` URI; an `http(s)` URL is stored as-is. Never downloads bytes.
 * First write wins: a later call for the same `partId` is a no-op.
 */
export function cacheFilePart(
  partId: string,
  payload: Readonly<{ url: string; mime: string; filename?: string }>
): void {
  if (entriesByPartId.has(partId)) {
    return;
  }
  entriesByPartId.set(partId, {
    url: resolveCacheUrl(partId, payload),
    mime: payload.mime,
    ...(payload.filename ? { filename: payload.filename } : {}),
  });
  emitChange();
}

/** Synchronous lookup used by tests. */
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

/** True only for `http:`, `https:`, `data:`, and `file:` URLs. */
export function isUsableFilePartUrl(url: string): boolean {
  return (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('data:') ||
    url.startsWith('file://')
  );
}

/** Test-only: clear in-memory state between cases. */
export function __resetFilePartCacheForTests(): void {
  entriesByPartId.clear();
  emitChange();
}

import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

import { getSafeCacheFilename } from '@/lib/share-remote-file';

import { type CloudAgentAttachmentRef, parseCloudAgentAttachmentUrl } from './file-part-preview';
import { stripDataUrlBase64Prefix } from './tool-card-image-cache';

const CACHE_DIR_NAME = 'session-file-parts';

/** A captured FilePart URL. `data:` URLs are written to disk and stored as a
 *  small `file://` URI; `http(s)` URLs are stored as-is. No bytes are
 *  downloaded. */
export type FilePartCacheEntry = {
  // resolved usable URL; ABSENT on ref-only entries
  url?: string;
  mime: string;
  filename?: string;
  attachmentRef?: CloudAgentAttachmentRef;
  // last on-demand presign failed; cleared on success/retry
  resolveFailed?: boolean;
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
 * to disk and stored as a `file://` URI; an `http(s)` URL is stored as-is.
 * Any other scheme is rejected (returns `undefined`). On any decode or write
 * failure the raw URL is stored instead. Never throws.
 */
function resolveCacheUrl(
  partId: string,
  payload: Readonly<{ url: string; mime: string; filename?: string }>
): string | undefined {
  if (!isUsableFilePartUrl(payload.url)) {
    return undefined;
  }
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
 * A cloud-agent sandbox `file://` attachment URL stores a ref-only entry (no
 * `url` key) for later on-demand presigning. First write wins: a later call
 * for the same `partId` is a no-op.
 */
export function cacheFilePart(
  partId: string,
  payload: Readonly<{ url: string; mime: string; filename?: string }>
): void {
  if (entriesByPartId.has(partId)) {
    return;
  }
  const ref = parseCloudAgentAttachmentUrl(payload.url);
  if (ref) {
    entriesByPartId.set(partId, {
      mime: payload.mime,
      ...(payload.filename ? { filename: payload.filename } : {}),
      attachmentRef: ref,
    });
    emitChange();
    return;
  }
  const url = resolveCacheUrl(partId, payload);
  if (url === undefined) {
    return;
  }
  entriesByPartId.set(partId, {
    url,
    mime: payload.mime,
    ...(payload.filename ? { filename: payload.filename } : {}),
  });
  emitChange();
}

/**
 * Replace a cached entry with a freshly resolved URL (e.g. a re-presigned
 * download URL). Preserves any attachment reference and clears the failed
 * mark. A `resolveCacheUrl` rejection returns without writing.
 */
export function overwriteFilePartCacheEntry(
  partId: string,
  payload: Readonly<{ url: string; mime: string; filename?: string }>
): void {
  const url = resolveCacheUrl(partId, payload);
  if (url === undefined) {
    return;
  }
  entriesByPartId.set(partId, {
    url,
    mime: payload.mime,
    ...(payload.filename ? { filename: payload.filename } : {}),
    attachmentRef: entriesByPartId.get(partId)?.attachmentRef,
  });
  emitChange();
}

/** Mark an existing entry's last on-demand presign as failed. */
export function markFilePartResolveFailed(partId: string): void {
  const entry = entriesByPartId.get(partId);
  if (!entry) {
    return;
  }
  entriesByPartId.set(partId, { ...entry, resolveFailed: true });
  emitChange();
}

/** Clear the failed mark from an existing entry. */
export function clearFilePartResolveFailed(partId: string): void {
  const entry = entriesByPartId.get(partId);
  if (!entry) {
    return;
  }
  const next = { ...entry };
  delete next.resolveFailed;
  entriesByPartId.set(partId, next);
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

/** True only for `http:`, `https:`, and `data:` URLs. */
export function isUsableFilePartUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:');
}

/** Test-only: clear in-memory state between cases. */
export function __resetFilePartCacheForTests(): void {
  entriesByPartId.clear();
  emitChange();
}

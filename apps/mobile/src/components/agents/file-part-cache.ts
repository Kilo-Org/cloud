import { Directory, File, Paths } from 'expo-file-system';
import { useCallback, useSyncExternalStore } from 'react';

import { getSafeCacheFilename } from '@/lib/share-remote-file';

import { type CloudAgentAttachmentRef, parseCloudAgentAttachmentUrl } from './file-part-preview';
import { createPartSubscriptions } from './part-subscriptions';
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
  // absolute expiry (ms since epoch) of a presigned `url`; old in-memory
  // entries omit `urlExpiresAt` — remove the missing-field branch when no
  // pre-renewal client remains in production
  urlExpiresAt?: number;
  // an automatic URL renew is in flight while the last-good URL is still shown
  renewing?: boolean;
  // last on-demand presign failed; cleared on success/retry
  resolveFailed?: boolean;
  // a `data:` body is being written; `url` lands when the write resolves
  writePending?: boolean;
};

/** Reactive map of partId → captured FilePart entry. First write wins. */
const entriesByPartId = new Map<string, FilePartCacheEntry>();
const subscriptions = createPartSubscriptions();
/** Part ids whose `data:` body is still being written; keeps first write wins
 *  while the bytes land instead of publishing an entry with no file behind it. */
const pendingPartIds = new Set<string>();
/** Bumped by every reset; a write that started before a reset never publishes
 *  its entry into the next account's map. */
let cacheGeneration = 0;

function emitChange(partId: string): void {
  subscriptions.notify(partId);
}

/**
 * Write a `data:` URL's base64 body to the cache and resolve its `file://` URI.
 * `File.write` is the asynchronous API: the base64 decode and the disk write run
 * on the native side, so the JS thread keeps rendering the transcript while a
 * multi-megabyte attachment is persisted. Resolves the raw URL when the payload
 * is not base64 or the write fails. Never throws.
 */
async function persistDataUrl(
  partId: string,
  payload: Readonly<{ url: string; mime: string; filename?: string }>
): Promise<string> {
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
    await file.write(stripped, { encoding: 'base64' });
    return file.uri;
  } catch {
    return payload.url;
  }
}

function entryFor(
  payload: Readonly<{ url: string; mime: string; filename?: string }>,
  url: string
): FilePartCacheEntry {
  return {
    url,
    mime: payload.mime,
    ...(payload.filename ? { filename: payload.filename } : {}),
  };
}

/** Persist a `data:` payload off the caller's turn and hand the resulting URL to
 *  `publish` once the write resolves, unless a reset intervened. */
function persistAndPublish(
  partId: string,
  payload: Readonly<{ url: string; mime: string; filename?: string }>,
  publish: (url: string) => void
): void {
  pendingPartIds.add(partId);
  const generation = cacheGeneration;
  void (async () => {
    try {
      const url = await persistDataUrl(partId, payload);
      if (generation === cacheGeneration) {
        publish(url);
      }
    } finally {
      pendingPartIds.delete(partId);
    }
  })();
}

/**
 * Record a captured FilePart URL. A `data:` URL is written to disk and stored
 * as a `file://` URI; an `http(s)` URL is stored as-is. Never downloads bytes.
 * A cloud-agent sandbox `file://` attachment URL stores a ref-only entry (no
 * `url` key) for later on-demand presigning. First write wins: a later call
 * for the same `partId` is a no-op. A `data:` part publishes a `writePending`
 * entry immediately and its `url` when the write resolves, so the renderer
 * shows a loading surface instead of the inline base64 body.
 */
export function cacheFilePart(
  partId: string,
  payload: Readonly<{ url: string; mime: string; filename?: string }>
): void {
  if (entriesByPartId.has(partId) || pendingPartIds.has(partId)) {
    return;
  }
  const ref = parseCloudAgentAttachmentUrl(payload.url);
  if (ref) {
    entriesByPartId.set(partId, {
      mime: payload.mime,
      ...(payload.filename ? { filename: payload.filename } : {}),
      attachmentRef: ref,
    });
    emitChange(partId);
    return;
  }
  if (!isUsableFilePartUrl(payload.url)) {
    return;
  }
  if (!payload.url.startsWith('data:')) {
    entriesByPartId.set(partId, entryFor(payload, payload.url));
    emitChange(partId);
    return;
  }
  entriesByPartId.set(partId, {
    mime: payload.mime,
    ...(payload.filename ? { filename: payload.filename } : {}),
    writePending: true,
  });
  emitChange(partId);
  persistAndPublish(partId, payload, url => {
    entriesByPartId.set(partId, entryFor(payload, url));
    emitChange(partId);
  });
}

/**
 * Replace a cached entry with a freshly resolved URL (e.g. a re-presigned
 * download URL). Preserves any attachment reference and clears the failed
 * mark. If the payload URL is unusable the entry is not written. A `data:`
 * payload is written off the caller's turn like {@link cacheFilePart}.
 */
export function overwriteFilePartCacheEntry(
  partId: string,
  payload: Readonly<{ url: string; mime: string; filename?: string; urlExpiresAt?: number }>
): void {
  if (!isUsableFilePartUrl(payload.url)) {
    return;
  }
  if (!payload.url.startsWith('data:')) {
    applyOverwrite(partId, payload, payload.url);
    return;
  }
  persistAndPublish(partId, payload, url => {
    applyOverwrite(partId, payload, url);
  });
}

function applyOverwrite(
  partId: string,
  payload: Readonly<{ url: string; mime: string; filename?: string; urlExpiresAt?: number }>,
  url: string
): void {
  entriesByPartId.set(partId, {
    url,
    mime: payload.mime,
    ...(payload.filename ? { filename: payload.filename } : {}),
    ...(payload.urlExpiresAt !== undefined ? { urlExpiresAt: payload.urlExpiresAt } : {}),
    attachmentRef: entriesByPartId.get(partId)?.attachmentRef,
  });
  emitChange(partId);
}

/** Mark an existing entry's last on-demand presign as failed. */
export function markFilePartResolveFailed(partId: string): void {
  const entry = entriesByPartId.get(partId);
  if (!entry) {
    return;
  }
  const next = { ...entry, resolveFailed: true };
  delete next.renewing;
  entriesByPartId.set(partId, next);
  emitChange(partId);
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
  emitChange(partId);
}

/** Mark an existing entry as having an automatic URL renew in flight. */
export function markFilePartRenewing(partId: string): void {
  const entry = entriesByPartId.get(partId);
  if (!entry) {
    return;
  }
  entriesByPartId.set(partId, { ...entry, renewing: true });
  emitChange(partId);
}

/** Clear the renewing mark from an existing entry. */
export function clearFilePartRenewing(partId: string): void {
  const entry = entriesByPartId.get(partId);
  if (!entry) {
    return;
  }
  const next = { ...entry };
  delete next.renewing;
  entriesByPartId.set(partId, next);
  emitChange(partId);
}

/** Synchronous lookup used by tests. */
export function getFilePartCacheEntry(partId: string): FilePartCacheEntry | undefined {
  return entriesByPartId.get(partId);
}

export function getFilePartCacheGeneration(): number {
  return cacheGeneration;
}

/** Copy of the in-memory map for the resolver's renewal sweep. */
export function listFilePartCacheEntries(): readonly {
  partId: string;
  entry: FilePartCacheEntry;
}[] {
  return Array.from(entriesByPartId, ([partId, entry]) => ({ partId, entry }));
}

/**
 * Reactive lookup of a captured FilePart entry. Returns `undefined` until a
 * write is recorded for `partId`. The snapshot is the entry object itself so
 * a post-mount write (e.g. an on-demand presign) re-renders that part's
 * subscribers; a write for another part does not wake them.
 */
export function useFilePartCache(partId: string): FilePartCacheEntry | undefined {
  const subscribe = useCallback(
    (listener: () => void) => subscriptions.subscribe(partId, listener),
    [partId]
  );
  const getSnapshot = useCallback(() => entriesByPartId.get(partId), [partId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** True only for `http:`, `https:`, and `data:` URLs. */
export function isUsableFilePartUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:');
}

/**
 * Delete the on-disk cache directory (if present) and reset the in-memory
 * map for sign-out or account switch. Best-effort: a delete failure never
 * throws. The modern file-system API only deletes synchronously, so this runs
 * on the teardown's own turn; a `data:` write still in flight when it runs
 * sees the bumped generation and publishes nothing.
 */
export function clearFilePartCache(): void {
  try {
    const directory = new Directory(Paths.cache, CACHE_DIR_NAME);
    if (directory.exists) {
      directory.delete();
    }
  } catch {
    // Best-effort cache hygiene; ignore delete failures.
  }
  cacheGeneration += 1;
  pendingPartIds.clear();
  entriesByPartId.clear();
  subscriptions.notifyAll();
}

/** Test-only: clear in-memory state between cases. */
export function __resetFilePartCacheForTests(): void {
  cacheGeneration += 1;
  pendingPartIds.clear();
  entriesByPartId.clear();
  subscriptions.notifyAll();
}

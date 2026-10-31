import { Directory, File, Paths } from 'expo-file-system';
import { useCallback, useSyncExternalStore } from 'react';

import { getSafeCacheFilename } from '@/lib/share-remote-file';

import { createPartSubscriptions } from './part-subscriptions';

const CACHE_DIR_NAME = 'tool-card-images';

/** part ids currently writing or already written this process lifetime */
const inFlightOrDone = new Set<string>();
/** part ids whose write is in flight; the card shows a loading surface instead
 *  of reporting the attachment unavailable. */
const pendingPartIds = new Set<string>();

/** Reactive map of partId → file:// URI, updated only after a successful write. */
const urisByPartId = new Map<string, string>();
/** Per-part snapshot counter, so a subscriber re-renders on every state change
 *  of its own part (a landed URI, or a pending write turning into a failure)
 *  and is never woken by another part. */
const versionByPartId = new Map<string, number>();
const subscriptions = createPartSubscriptions();
/** Bumped by every reset; a write that started before a reset never publishes
 *  its URI into the next account's map. */
let cacheGeneration = 0;

let cacheDirectory: Directory | undefined = undefined;

/** Wake the subscribers of one part whose state changed. */
function emitChange(partId: string): void {
  versionByPartId.set(partId, (versionByPartId.get(partId) ?? 0) + 1);
  subscriptions.notify(partId);
}

function ensureCacheDirectory(): Directory {
  if (!cacheDirectory) {
    const directory = new Directory(Paths.cache, CACHE_DIR_NAME);
    directory.create({ idempotent: true, intermediates: true });
    // Assign only after create() returns: a directory whose creation threw must
    // not be memoized, or every later attachment would inherit the failure.
    cacheDirectory = directory;
  }
  return cacheDirectory;
}

/**
 * Map any MIME type to a file extension.
 * `image/jpeg` → `jpg`; `application/pdf` → `pdf`; `text/plain` → `txt`.
 * Falls back to `bin` when the MIME has no slash or an empty subtype.
 */
export function extensionForMime(mime: string): string {
  const slashIdx = mime.indexOf('/');
  if (slashIdx === -1) {
    return 'bin';
  }
  const subtype = mime.slice(slashIdx + 1).toLowerCase();
  if (subtype === 'jpeg') {
    return 'jpg';
  }
  return subtype.length > 0 ? subtype : 'bin';
}

/**
 * Map an image mime to a file extension.
 * `image/jpeg` → `jpg`; other `image/*` subtypes use the subtype as-is.
 */
export function extensionForImageMime(mime: string): string {
  return extensionForMime(mime);
}

/**
 * Strip the `data:<mime>;base64,` prefix from a data URL. Returns undefined
 * when the payload is not a base64 data URL for the given mime.
 */
export function stripDataUrlBase64Prefix(dataUrl: string, mime: string): string | undefined {
  const prefix = `data:${mime};base64,`;
  if (!dataUrl.startsWith(prefix)) {
    // Tolerant fallback: any data URL with a base64 payload.
    const generic = /^data:[^;]+;base64,/;
    const match = generic.exec(dataUrl);
    if (!match) {
      return undefined;
    }
    return dataUrl.slice(match[0].length);
  }
  return dataUrl.slice(prefix.length);
}

/** Marker inserted before the extension so `getSafeCacheFilename`-processed
 *  filenames can be restored to legacy `<partId>.<extension>` naming. */
const DOT_MARKER = '_DOT_';

function cacheFilenameForAttachment(partId: string, mime: string, filename?: string): string {
  if (filename) {
    return getSafeCacheFilename({ id: partId, filename });
  }
  const safe = getSafeCacheFilename({
    id: partId,
    filename: `${DOT_MARKER}${extensionForMime(mime)}`,
  });
  const pattern = DOT_MARKER.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  return safe.replace(new RegExp(`-${pattern}(?!.*-${pattern})`), '.');
}

/**
 * Fire-and-forget sink for completed tool-part attachments.
 * Never throws. First attachment wins for a multi-attachment part (no tool
 * emits multi-attachment parts today; documented, not handled specially beyond
 * the part-id Set which also covers that case).
 *
 * The part id is marked synchronously so a live-stream pass and a history-replay
 * pass cannot double-write it, and the card renders a loading surface while the
 * body is written. The directory create and the exists check are synchronous
 * native calls on the caller's turn; the base64 decode and the disk write are
 * not — `await file.write(...)` hands those to the native file-system thread, so
 * an arbitrarily large attachment no longer holds the JS thread that publishes
 * the stream. The URI is recorded when the write resolves.
 *
 * When `filename` is provided (non-image attachments), the cache filename is
 * derived via `getSafeCacheFilename`. When absent (images), the legacy
 * `partId.extensionForImageMime(mime)` naming is used. The partId→uri map and
 * first-wins dedupe are unchanged.
 */
export function cacheToolAttachment(
  partId: string,
  { mime, dataUrl, filename }: Readonly<{ mime: string; dataUrl: string; filename?: string }>
): void {
  if (inFlightOrDone.has(partId)) {
    return;
  }
  // Mark synchronously so a live-stream pass and a history-replay pass cannot
  // double-write the same part.
  inFlightOrDone.add(partId);

  const payload = stripDataUrlBase64Prefix(dataUrl, mime);
  if (payload === undefined || payload.length === 0) {
    inFlightOrDone.delete(partId);
    return;
  }

  const generation = cacheGeneration;
  pendingPartIds.add(partId);
  emitChange(partId);
  void (async () => {
    try {
      const directory = ensureCacheDirectory();
      const file = new File(directory, cacheFilenameForAttachment(partId, mime, filename));
      if (!file.exists) {
        await file.write(payload, { encoding: 'base64' });
      }
      pendingPartIds.delete(partId);
      if (generation === cacheGeneration) {
        urisByPartId.set(partId, file.uri);
      }
      emitChange(partId);
    } catch {
      // A failed create or write clears the mark so the next pass retries.
      pendingPartIds.delete(partId);
      inFlightOrDone.delete(partId);
      emitChange(partId);
    }
  })();
}

/**
 * Backward-compatible alias. Calls {@link cacheToolAttachment} without a
 * filename, using the legacy extension-based naming. Kept for existing
 * consumers that don't pass a filename (call sites that only handle images).
 *
 */
export function cacheToolCardImage(partId: string, mime: string, dataUrl: string): void {
  cacheToolAttachment(partId, { mime, dataUrl });
}

/** Synchronous lookup used by the hook and by tests. */
export function getToolCardImageUri(partId: string): string | undefined {
  return urisByPartId.get(partId);
}

/** True while the part's body is being written and no URI is recorded yet. */
export function isToolCardImagePending(partId: string): boolean {
  return pendingPartIds.has(partId);
}

/**
 * Reactive lookup of a cached tool-card image URI.
 * Returns `undefined` until a successful write (or a pre-existing file) is
 * recorded for `partId`. Each hook subscribes to its own part, so a change to
 * one attachment's state re-renders only the cards mounted for that part.
 */
export function useToolCardImageUri(partId: string): string | undefined {
  const subscribe = useCallback(
    (listener: () => void) => subscriptions.subscribe(partId, listener),
    [partId]
  );
  const getSnapshot = useCallback(() => versionByPartId.get(partId) ?? 0, [partId]);
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return urisByPartId.get(partId);
}

/**
 * Delete the on-disk cache directory (if present) and reset the in-memory
 * maps for sign-out or account switch. Best-effort: a delete failure never
 * throws. The modern file-system API only deletes synchronously, so this runs
 * on the teardown's own turn; a write still in flight when it runs sees the
 * bumped generation and records nothing.
 */
export function clearToolCardImageCache(): void {
  try {
    const directory = new Directory(Paths.cache, CACHE_DIR_NAME);
    if (directory.exists) {
      directory.delete();
    }
  } catch {
    // Best-effort cache hygiene; ignore delete failures.
  }
  cacheGeneration += 1;
  inFlightOrDone.clear();
  pendingPartIds.clear();
  urisByPartId.clear();
  versionByPartId.clear();
  cacheDirectory = undefined;
  subscriptions.notifyAll();
}

/** Test-only: clear in-memory state between cases. */
export function __resetToolCardImageCacheForTests(): void {
  cacheGeneration += 1;
  inFlightOrDone.clear();
  pendingPartIds.clear();
  urisByPartId.clear();
  versionByPartId.clear();
  cacheDirectory = undefined;
  subscriptions.notifyAll();
}

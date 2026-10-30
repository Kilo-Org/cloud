import { Directory, File, Paths } from 'expo-file-system';
import { useCallback, useSyncExternalStore } from 'react';

import { getSafeCacheFilename } from '@/lib/share-remote-file';

import { createPartSubscriptions } from './part-subscriptions';

const CACHE_DIR_NAME = 'tool-card-images';

/** part ids currently writing or already written this process lifetime */
const inFlightOrDone = new Set<string>();

/** Reactive map of partId → file:// URI, updated only after a successful write. */
const urisByPartId = new Map<string, string>();
const subscriptions = createPartSubscriptions();
/** Bumped by every reset; a write that started before a reset never publishes
 *  its URI into the next account's map. */
let cacheGeneration = 0;

let cacheDirectory: Directory | undefined = undefined;

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

function recordUri(partId: string, uri: string): void {
  if (urisByPartId.get(partId) === uri) {
    return;
  }
  urisByPartId.set(partId, uri);
  subscriptions.notify(partId);
}

/**
 * Fire-and-forget sink for completed tool-part attachments.
 * Never throws. First attachment wins for a multi-attachment part (no tool
 * emits multi-attachment parts today; documented, not handled specially beyond
 * the part-id Set which also covers that case).
 *
 * The part id is marked synchronously, then the directory, the exists check and
 * the write run off the caller's turn: `File.write` is the asynchronous API, so
 * the base64 decode and the disk write of an arbitrarily large attachment never
 * hold the JS thread that is publishing the stream. The URI is published when
 * the write resolves.
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
  void (async () => {
    try {
      const directory = ensureCacheDirectory();
      const file = new File(directory, cacheFilenameForAttachment(partId, mime, filename));
      if (!file.exists) {
        await file.write(payload, { encoding: 'base64' });
      }
      if (generation === cacheGeneration) {
        recordUri(partId, file.uri);
      }
    } catch {
      // A failed create or write clears the mark so the next pass retries.
      inFlightOrDone.delete(partId);
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

/**
 * Reactive lookup of a cached tool-card image URI.
 * Returns `undefined` until a successful write (or a pre-existing file) is
 * recorded for `partId`. Each hook subscribes to its own part, so recording one
 * attachment's URI re-renders only the cards mounted for that part.
 */
export function useToolCardImageUri(partId: string): string | undefined {
  const subscribe = useCallback(
    (listener: () => void) => subscriptions.subscribe(partId, listener),
    [partId]
  );
  const getSnapshot = useCallback(() => urisByPartId.get(partId), [partId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
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
  urisByPartId.clear();
  cacheDirectory = undefined;
  subscriptions.notifyAll();
}

/** Test-only: clear in-memory state between cases. */
export function __resetToolCardImageCacheForTests(): void {
  cacheGeneration += 1;
  inFlightOrDone.clear();
  urisByPartId.clear();
  cacheDirectory = undefined;
  subscriptions.notifyAll();
}

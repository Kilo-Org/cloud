import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

import { getSafeCacheFilename } from '@/lib/share-remote-file';

const CACHE_DIR_NAME = 'tool-card-images';

/** part ids currently writing or already written this process lifetime */
const inFlightOrDone = new Set<string>();

/** Reactive map of partId → file:// URI, updated only after a successful write. */
const urisByPartId = new Map<string, string>();
const listeners = new Set<() => void>();
/** Bumped on every URI map mutation so useSyncExternalStore sees a new snapshot. */
let urisVersion = 0;

let cacheDirectory: Directory | undefined = undefined;

function emitChange(): void {
  urisVersion += 1;
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
  return urisVersion;
}

function ensureCacheDirectory(): Directory {
  if (!cacheDirectory) {
    cacheDirectory = new Directory(Paths.cache, CACHE_DIR_NAME);
    cacheDirectory.create({ idempotent: true, intermediates: true });
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
  urisByPartId.set(partId, uri);
  emitChange();
}

/**
 * Fire-and-forget sink for completed tool-part attachments.
 * Never throws. First attachment wins for a multi-attachment part (no tool
 * emits multi-attachment parts today; documented, not handled specially beyond
 * the part-id Set which also covers that case).
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
  try {
    if (inFlightOrDone.has(partId)) {
      return;
    }
    // Mark synchronously so a live-stream pass and a history-replay pass
    // cannot double-write the same part.
    inFlightOrDone.add(partId);

    const payload = stripDataUrlBase64Prefix(dataUrl, mime);
    if (payload === undefined || payload.length === 0) {
      inFlightOrDone.delete(partId);
      return;
    }

    const directory = ensureCacheDirectory();
    const cacheFilename = cacheFilenameForAttachment(partId, mime, filename);
    const file = new File(directory, cacheFilename);

    if (file.exists) {
      recordUri(partId, file.uri);
      return;
    }

    file.write(payload, { encoding: 'base64' });
    recordUri(partId, file.uri);
  } catch {
    inFlightOrDone.delete(partId);
  }
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
 * recorded for `partId`.
 */
export function useToolCardImageUri(partId: string): string | undefined {
  useSyncExternalStore(subscribe, getVersionSnapshot, getVersionSnapshot);
  return urisByPartId.get(partId);
}

/**
 * Delete the on-disk cache directory (if present) and reset the in-memory
 * maps for sign-out or account switch. Best-effort: a delete failure never
 * throws and never blocks the teardown.
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
  inFlightOrDone.clear();
  urisByPartId.clear();
  cacheDirectory = undefined;
  emitChange();
}

/** Test-only: clear in-memory state between cases. */
export function __resetToolCardImageCacheForTests(): void {
  inFlightOrDone.clear();
  urisByPartId.clear();
  cacheDirectory = undefined;
  emitChange();
}

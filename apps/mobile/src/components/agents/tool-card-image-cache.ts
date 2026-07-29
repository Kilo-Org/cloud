import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';

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
 * Map an image mime to a file extension.
 * `image/jpeg` → `jpg`; other `image/*` subtypes use the subtype as-is.
 */
export function extensionForImageMime(mime: string): string {
  const subtype = mime.slice('image/'.length).toLowerCase();
  if (subtype === 'jpeg') {
    return 'jpg';
  }
  return subtype.length > 0 ? subtype : 'bin';
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

function recordUri(partId: string, uri: string): void {
  urisByPartId.set(partId, uri);
  emitChange();
}

/**
 * Fire-and-forget sink for completed tool-part image attachments.
 * Never throws. First image attachment wins for a multi-image part (no tool
 * emits multi-image parts today; documented, not handled specially beyond
 * the part-id Set which also covers that case).
 */
export function cacheToolCardImage(partId: string, mime: string, dataUrl: string): void {
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
    const filename = `${partId}.${extensionForImageMime(mime)}`;
    const file = new File(directory, filename);

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

/** Test-only: clear in-memory state between cases. */
export function __resetToolCardImageCacheForTests(): void {
  inFlightOrDone.clear();
  urisByPartId.clear();
  cacheDirectory = undefined;
  emitChange();
}

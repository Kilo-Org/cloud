import { Directory, File, Paths } from 'expo-file-system';
import { useCallback, useSyncExternalStore } from 'react';

import { getSafeCacheFilename } from '@/lib/share-remote-file';
import { truncateUtf8, utf8ByteLength } from '@/lib/utf8-utils';

import { createPartSubscriptions } from './part-subscriptions';

const CACHE_DIR_NAME = 'tool-card-images';

/** part ids currently writing or already written this process lifetime */
const inFlightOrDone = new Set<string>();
/** part ids whose write attempt failed on this device and may not be
 *  re-attempted until the next cache reset clears the latch. */
const failedPartIds = new Set<string>();
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
/** Bumped by every reset; a write that started before a reset mutates nothing
 *  into the next generation — no URI, no pending or dedupe marks, no failure
 *  latch. */
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

/** Decoded byte count of a base64 payload, from its length and padding.
 *  `apps/mobile/src/lib/artifacts/artifact-crawl.ts` carries the same
 *  arithmetic; duplicated locally because importing that module would pull an
 *  unrelated heavy dependency into this import graph. */
function base64DecodedByteLength(payload: string): number {
  let padding = 0;
  if (payload.endsWith('==')) {
    padding = 2;
  } else if (payload.endsWith('=')) {
    padding = 1;
  }
  return Math.floor((payload.length * 3) / 4) - padding;
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

/** Per-attempt suffix for the temp sibling the body is written into before the
 *  move; the counter keeps concurrent attempts of one part from colliding. */
let tempWriteCounter = 0;

/**
 * Build a unique `<final>.tmp-<n>` sibling name. The 5-byte suffix and the
 * counter that arrives during this process lifetime fit inside the 255-byte
 * filename budget the sanitized names are already subject to: when the final
 * name is near the cap, the counter tail is dropped from it again rather than
 * extending past it.
 */
function tempFilenameFor(finalName: string): string {
  tempWriteCounter += 1;
  const suffix = `.tmp-${tempWriteCounter}`;
  const budget = 247;
  const finalBytes = utf8ByteLength(finalName);
  if (finalBytes + suffix.length <= budget) {
    return finalName + suffix;
  }
  const finalStem = truncateUtf8(finalName, budget - suffix.length);
  return finalStem + suffix;
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
 * the stream.
 *
 * The body is written to a `<final>.tmp-<n>` sibling and moved onto the final
 * name only after the write resolves, so a partial or interrupted write never
 * leaves a file under the final name. A file under the final name is reused
 * only when its size equals the decoded payload size: a truncated file from an
 * interrupted or legacy write (an older version wrote straight at the final
 * name) is rewritten rather than served. A failed attempt latches the part id:
 * no further writes run for it until `clearToolCardImageCache` (sign-out) or a
 * test reset, so a corrupt environment does not turn a long transcript into a
 * retry storm; a stale attempt still deletes its own temp sibling before
 * withdrawing, so no leftover `<final>.tmp-<n>` file outlives a reset. The URI
 * is recorded when the move resolves.
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
  if (failedPartIds.has(partId)) {
    return;
  }
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
    let tempFile: File | undefined = undefined;
    const finalName = cacheFilenameForAttachment(partId, mime, filename);
    try {
      const directory = ensureCacheDirectory();
      // A file counts as cached only when its body is the whole payload: an
      // interrupted legacy write, or a file left by an older version that wrote
      // straight at the final name, is truncated and must be rewritten instead
      // of published.
      const expectedBytes = base64DecodedByteLength(payload);
      const file = new File(directory, finalName);
      if (!file.exists || file.size !== expectedBytes) {
        tempFile = new File(directory, tempFilenameFor(finalName));
        await tempFile.write(payload, { encoding: 'base64' });
        if (generation !== cacheGeneration) {
          // The cache was reset while the write ran; this attempt owns nothing
          // anymore, so it publishes no state — not even the on-disk move —
          // into the new generation. The marks it left behind were dropped by
          // the reset itself, and its own temp sibling is cleaned up so no
          // `<final>.tmp-<n>` body outlives the reset.
          bestEffortDelete(tempFile);
          return;
        }
        await tempFile.move(file, { overwrite: true });
      }
      if (generation !== cacheGeneration) {
        // The reuse path (no awaits) can never see this; the move path rechecks
        // because the reset may have run while the move was in flight.
        return;
      }
      pendingPartIds.delete(partId);
      // The dedupe mark stays: a written part is never written again.
      urisByPartId.set(partId, file.uri);
      emitChange(partId);
    } catch {
      // A failed attempt latches the part id: the next pass performs no
      // file-system work for it until a reset clears the latch. The temp
      // sibling is deleted best-effort in every generation: it belongs to this
      // attempt alone (its name carries a per-attempt counter), and a reset may
      // already have deleted the directory that held it, which the helper
      // swallows.
      if (tempFile) {
        bestEffortDelete(tempFile);
      }
      if (generation !== cacheGeneration) {
        // The cache was reset while the write ran; this attempt publishes
        // nothing into the new generation — no latch, no pending mark, no URI.
        return;
      }
      pendingPartIds.delete(partId);
      failedPartIds.add(partId);
      inFlightOrDone.delete(partId);
      emitChange(partId);
    }
  })();
}

/** Delete a temp file without letting the cleanup failure shadow the original
 *  write failure. */
function bestEffortDelete(file: File): void {
  try {
    file.delete();
  } catch {
    // The temp name carries a per-attempt counter, so a leftover file cannot
    // collide with a later attempt's temp name nor be mistaken for a final one.
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
 * maps (and the failure latch) for sign-out or account switch. Best-effort: a
 * delete failure never throws. The modern file-system API only deletes
 * synchronously, so this runs on the teardown's own turn; a write still in
 * flight when it runs sees the bumped generation and records nothing into the
 * next generation.
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
  failedPartIds.clear();
  // `tempWriteCounter` stays process-monotonic: temp names are unique per
  // attempt, so a leftover temp can never collide with a later one.
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
  failedPartIds.clear();
  urisByPartId.clear();
  versionByPartId.clear();
  cacheDirectory = undefined;
  subscriptions.notifyAll();
}

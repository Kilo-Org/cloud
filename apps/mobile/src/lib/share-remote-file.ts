import { withDeadline } from '@kilocode/event-service';
import { Directory, File, Paths } from 'expo-file-system';
import { fetch } from 'expo/fetch';
import * as Sharing from 'expo-sharing';

import { registerTempFile } from './temp-file-registry';
import { isAbortError, isRequestDeadlineError } from './telemetry/abort-classification';
import { truncateUtf8, utf8ByteLength } from './utf8-utils';

const MAX_CACHE_FILENAME_BYTES = 255;

/**
 * How long a share's transfer may take. A phone on a bad connection still
 * finishes a session attachment or an invoice inside this; past it the caller
 * gets `download-timeout` instead of an indefinite spinner.
 */
export const SHARE_DOWNLOAD_DEADLINE_MS = 30_000;

export type ShareRemoteFileReason =
  | 'sharing-unavailable'
  | 'download-timeout'
  | 'download-network'
  | 'download-http-status'
  | 'download-failed';

export class ShareRemoteFileError extends Error {
  readonly reason: ShareRemoteFileReason;
  /** The response status for `download-http-status`; `undefined` otherwise. */
  readonly httpStatus: number | undefined;

  constructor(reason: ShareRemoteFileReason, options?: { cause?: unknown; httpStatus?: number }) {
    super(reason, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ShareRemoteFileError';
    this.reason = reason;
    this.httpStatus = options?.httpStatus;
  }
}

/**
 * A 4xx that names a definitive refusal: the request as written can never
 * succeed, so the surface says the file is unavailable. 408 and 429 are
 * explicitly retryable; 401 and 403 are retried too, because a cloud-agent
 * attachment URL is a presigned link that a later tap re-signs. A 5xx is the
 * origin's own bad moment, not a fact about the file.
 */
function isTerminalStatus(status: number): boolean {
  if (status === 401 || status === 403 || status === 408 || status === 429) {
    return false;
  }
  return status >= 400 && status < 500;
}

/** What the user can do about a failed share, which is what the copy asks. */
export type ShareFailureKind = 'sharing-unavailable' | 'retry' | 'file-unavailable' | 'general';

export function getShareFailureKind(error: unknown): ShareFailureKind {
  if (!(error instanceof ShareRemoteFileError)) {
    return 'general';
  }
  if (error.reason === 'sharing-unavailable') {
    return 'sharing-unavailable';
  }
  if (error.reason === 'download-http-status') {
    return error.httpStatus !== undefined && isTerminalStatus(error.httpStatus)
      ? 'file-unavailable'
      : 'retry';
  }
  return 'retry';
}

export type MaterializedRemoteFile = {
  uri: string;
  delete: () => void;
};

export function getShareRemoteFileReason(error: unknown): ShareRemoteFileReason | null {
  if (error instanceof ShareRemoteFileError) {
    return error.reason;
  }
  return null;
}

/**
 * A copy of `sink` that reports a rejected write as `download-failed`. `pipeTo`
 * rejects with either end's error, so the sink is the only side that can say
 * the file itself could not be written — and it says so with the module's own
 * type, which classification then passes through untouched.
 */
function markLocalWrites(sink: WritableStream<Uint8Array>): WritableStream<Uint8Array> {
  const writer = sink.getWriter();
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        await writer.write(chunk);
      } catch (error) {
        throw new ShareRemoteFileError('download-failed', { cause: error });
      }
    },
    close: () => writer.close(),
    abort: reason => writer.abort(reason),
  });
}

/**
 * Fetch `url` into `target`, streaming the body into the file instead of
 * buffering it. A non-2xx response writes nothing and releases the body.
 */
async function fetchIntoFile(url: string, target: File, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    // The caller keeps no bytes from a failed status, so release the body
    // rather than leaving the connection's stream unread.
    await response.body?.cancel();
    throw new ShareRemoteFileError('download-http-status', { httpStatus: response.status });
  }
  try {
    // A null body is an empty file, not an empty buffer: written empty matches
    // what the response actually carried.
    await (response.body ?? new Blob([]).stream()).pipeTo(markLocalWrites(target.writableStream()));
  } catch (error) {
    try {
      await response.body?.cancel();
    } catch {
      // A failed pipe already released the stream, so nothing is left to cancel.
    }
    throw error;
  }
}

/**
 * The reason one transfer failure stands for, in the order that decides it: a
 * failure the module already typed, then a deadline the helper raised, then an
 * abort the transfer reports for itself (Expo cancels with
 * `FetchRequestCanceledException`, not the deadline error, so an abort with no
 * caller cancel is the deadline's own), then whatever the transport raised. A
 * caller's own abort never reaches here: it propagates unchanged.
 */
function classifyDownloadError(error: unknown): ShareRemoteFileError {
  if (error instanceof ShareRemoteFileError) {
    return error;
  }
  if (isRequestDeadlineError(error) || isAbortError(error)) {
    return new ShareRemoteFileError('download-timeout', { cause: error });
  }
  return new ShareRemoteFileError('download-network', { cause: error });
}

export async function downloadRemoteFile({
  url,
  cacheDirectoryName,
  cacheFilename,
  deadlineMs = SHARE_DOWNLOAD_DEADLINE_MS,
  signal,
}: {
  url: string;
  cacheDirectoryName: string;
  cacheFilename: string;
  deadlineMs?: number;
  signal?: AbortSignal;
}): Promise<MaterializedRemoteFile> {
  const directory = new Directory(Paths.cache, cacheDirectoryName);
  const destination = new File(directory, cacheFilename);
  // The transfer writes its own file and only a completed one is moved onto the
  // destination: a failure can never truncate the copy an earlier share (or an
  // open preview) already handed to a receiving app under the same name.
  // The token keeps two attempts for one name apart even inside one millisecond.
  const attempt = new File(
    directory,
    tokenizedFilename(cacheFilename, nextTransferToken(), '.part-')
  );
  try {
    directory.create({ idempotent: true, intermediates: true });
    // Created before the request: iOS refuses to open a file that does not
    // exist and neither platform truncates on open, so a fresh empty file is
    // the only way the stream starts without a leftover tail.
    attempt.create({ intermediates: true, overwrite: true });
  } catch (error) {
    deleteQuietly(attempt);
    throw new ShareRemoteFileError('download-failed', { cause: error });
  }

  try {
    await withDeadline(
      deadlineMs,
      async deadlineSignal => {
        await fetchIntoFile(url, attempt, deadlineSignal);
      },
      signal
    );
  } catch (error) {
    deleteQuietly(attempt);
    // A caller's own cancel is not a download verdict: hand its reason back
    // unchanged so the surface that cancelled can tell why it did.
    if (signal?.aborted === true) {
      throw error === signal.reason ? error : signal.reason;
    }
    throw classifyDownloadError(error);
  }

  try {
    await attempt.move(destination, { overwrite: true });
  } catch (error) {
    // Local work, not the transport: the fetched bytes are useless if they
    // cannot be placed, and the destination keeps whatever it held.
    deleteQuietly(attempt);
    throw new ShareRemoteFileError('download-failed', { cause: error });
  }

  return {
    uri: destination.uri,
    delete: () => {
      destination.delete();
    },
  };
}

export async function shareLocalFile(
  localUri: string,
  options?: { mimeType?: string }
): Promise<void> {
  const available = await Sharing.isAvailableAsync();
  if (!available) {
    throw new ShareRemoteFileError('sharing-unavailable');
  }

  await Sharing.shareAsync(
    localUri,
    options?.mimeType ? { mimeType: options.mimeType } : undefined
  );
}

export async function shareMaterializedRemoteFile(
  file: MaterializedRemoteFile,
  shareFile: (uri: string) => Promise<void> = shareLocalFile
): Promise<void> {
  try {
    await shareFile(file.uri);
    // `shareAsync` resolves when the share sheet closes, not when the
    // receiving app finished reading the uri (Android hands the target a
    // lazily-read content:// uri). Deleting here truncates that read, so the
    // copy goes to the TTL reap instead.
    registerTempFile(file.uri);
  } catch (error) {
    // Nothing consumed the copy on the failure path, so drop it now.
    file.delete();
    throw error;
  }
}

export async function shareRemoteFile({
  url,
  cacheDirectoryName,
  cacheKey,
  filename,
  signal,
}: {
  url: string;
  cacheDirectoryName: string;
  cacheKey: string;
  filename: string;
  signal?: AbortSignal;
}): Promise<void> {
  // Every attempt keeps its own name: a second share of the same key must not
  // rewrite the file whose uri the first one already handed to a receiving app.
  const cacheFilename = tokenizedFilename(
    getSafeCacheFilename({ id: cacheKey, filename }),
    nextTransferToken(),
    '-'
  );
  const materialized = await downloadRemoteFile({
    url,
    cacheDirectoryName,
    cacheFilename,
    signal,
  });
  await shareMaterializedRemoteFile(materialized);
}

export function getSafeCacheFilename({ id, filename }: { id: string; filename: string }): string {
  const prefix = `${safePathSegment(id)}-`;
  const filenameBudget = MAX_CACHE_FILENAME_BYTES - utf8ByteLength(prefix);

  if (filenameBudget <= 0) {
    return truncateUtf8(prefix, MAX_CACHE_FILENAME_BYTES);
  }

  return `${prefix}${boundFilenameSegment(safePathSegment(filename), filenameBudget)}`;
}

/** One process-wide counter, so two attempts in the same millisecond differ. */
let transferTokenCounter = 0;

function nextTransferToken(): string {
  transferTokenCounter += 1;
  return `${transferTokenCounter.toString(36)}${Date.now().toString(36)}`;
}

/**
 * `filename` with `infix + token` inserted before its extension, bounded to
 * the cache's filename budget. The stem gives up bytes, never the token: two
 * attempts for one name must stay distinct after truncation. An extension that
 * cannot fit beside the token is dropped rather than the token.
 */
function tokenizedFilename(filename: string, token: string, infix: string): string {
  const extension = getExtension(filename);
  const stem = extension.length > 0 ? filename.slice(0, -extension.length) : filename;
  const marker = `${infix}${token}`;
  const withExtension = `${marker}${extension}`;
  const suffix = utf8ByteLength(withExtension) > MAX_CACHE_FILENAME_BYTES ? marker : withExtension;
  const stemBudget = MAX_CACHE_FILENAME_BYTES - utf8ByteLength(suffix);
  return `${truncateUtf8(stem, Math.max(stemBudget, 0))}${suffix}`;
}

function deleteQuietly(file: File): void {
  try {
    if (file.exists) {
      file.delete();
    }
  } catch {
    // The TTL reap removes an attempt that could not be deleted here.
  }
}

function safePathSegment(value: string): string {
  const sanitized = value.trim().replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  return sanitized.length > 0 ? sanitized : 'attachment';
}

function boundFilenameSegment(filename: string, maxBytes: number): string {
  if (utf8ByteLength(filename) <= maxBytes) {
    return filename;
  }

  const extension = getExtension(filename);
  const extensionBytes = utf8ByteLength(extension);
  if (extension.length > 0 && extensionBytes < maxBytes) {
    const stem = filename.slice(0, -extension.length);
    const truncatedStem = truncateUtf8(stem, maxBytes - extensionBytes);
    if (truncatedStem.length > 0) {
      return `${truncatedStem}${extension}`;
    }
  }

  return truncateUtf8(filename, maxBytes);
}

function getExtension(filename: string): string {
  const extensionStart = filename.lastIndexOf('.');
  if (extensionStart <= 0 || extensionStart === filename.length - 1) {
    return '';
  }

  return filename.slice(extensionStart);
}

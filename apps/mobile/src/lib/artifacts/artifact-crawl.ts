/* eslint-disable max-lines -- the crawl reads the session tree, bounds and materializes bytes, and assembles the mirror entries as one cohesive module */
import { type File } from 'expo-file-system';
import { fetch } from 'expo/fetch';

import { parseCloudAgentAttachmentUrl } from '@/components/agents/file-part-preview';
import { stripDataUrlBase64Prefix } from '@/components/agents/tool-card-image-cache';
import {
  type ArtifactMirrorFile,
  type ArtifactMirrorSession,
  safeArtifactDisplayName,
  safeArtifactSessionName,
  uniqueArtifactDisplayNames,
} from '@/lib/artifacts/artifact-mirror-manifest';
import { sessionDisplayTitle } from '@/lib/session-display-title';
import { trpcClient } from '@/lib/trpc';
import { parseHttpUrlAuthority } from '@/lib/url-authority';

/**
 * Reads the signed-in user's cloud-agent sessions and turns them into mirror
 * entries: the session rows, the file artifacts each session produced, and the
 * bytes those artifacts hold.
 *
 * The artifact predicate is the app's live chat sink, copied here so the mirror
 * shows exactly the files the chat shows: a top-level `file` part with a URL,
 * and a completed `tool` part's attachment when it is an image or came from
 * `send_file`. Everything else about the session (ordering, paging, byte
 * eviction) is the caller's; this module only reads and materializes.
 */

/** Sessions read in one list page. Matches the mobile history page size. */
export const MIRROR_SESSION_LIMIT = 50;

/** Largest artifact the mirror will hold; a bigger one is reported, not kept. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;

/**
 * How long the declared-length probe may take. The probe reads one response's
 * headers, so it is a round trip, not a transfer: fifteen seconds covers a slow
 * mobile handshake and still ends a dead request long before a foreground
 * session would notice.
 */
export const ARTIFACT_PROBE_TIMEOUT_MS = 15_000;

/**
 * One total budget per artifact transfer, not a per-chunk idle timeout: the
 * largest artifact the mirror keeps ({@link MAX_ARTIFACT_BYTES}, 25 MB) has to
 * fit on a slow phone connection at roughly 700 kbps, and a transfer that
 * stalls still ends the run well inside one foreground session instead of
 * holding the cursor forever.
 */
export const ARTIFACT_DOWNLOAD_TIMEOUT_MS = 300_000;

/**
 * The only network origin family a stored artifact URL may name: R2's S3 API
 * host, which is what every Kilo presign client mints
 * (`https://<account id>.r2.cloudflarestorage.com/<bucket>/<key>`). A stored URL
 * names a hosted artifact only on that family; any other origin reports
 * `unsupported`, so the mirror skips it and makes no request for it.
 */
const ARTIFACT_HOST_SUFFIX = '.r2.cloudflarestorage.com';

/** An R2 account id is the endpoint's only host label: 32 lowercase hex digits. */
const R2_ACCOUNT_LABEL = /^[0-9a-f]{32}$/;

/** Redirect hops a probe or a download follows before the artifact fails. */
const MAX_ARTIFACT_REDIRECTS = 5;

/** One artifact discovered in a session's stored messages. */
export type CrawledArtifact = {
  /** Agent-supplied filename, absent when the part carries none. */
  filename?: string;
  /** Part id, or `${partId}-${index}` for a later attachment on one tool part. */
  id: string;
  mime: string;
  /** Stored URL: a sandbox `file://` reference, a `data:` URL, or `http(s)`. */
  url: string;
};

/**
 * An artifact whose bytes were written: exactly the fields the mirror's
 * manifest records. The source `url` is deliberately absent — it can be a
 * `data:` URL carrying the whole payload, and nothing reads it back.
 */
export type MaterializedArtifact = {
  filename?: string;
  id: string;
  mime: string;
  size: number;
};

type ArtifactMaterializeFailure = 'download-failed' | 'too-large' | 'unsupported';

export type ArtifactMaterializeResult =
  | { ok: true; size: number }
  | { ok: false; reason: ArtifactMaterializeFailure };

/** A session row reduced to the fields the mirror's index needs. */
export type MirrorSessionRow = {
  id: string;
  title: string | null;
  updatedAt: string;
};

export type MirrorSessionPage = {
  nextCursor: string | null;
  sessions: MirrorSessionRow[];
};

export type MirrorMessagePage = {
  messages: unknown[];
  /** The next page's cursor, or the unchanged input cursor after a failure. */
  nextCursor: string | null;
  /**
   * Set when the worker returned a typed failure instead of a page: `retryable`
   * for a transient read issue, `terminal` for a stored history the worker
   * cannot page at all (`invalid_data`, `too_large`). It has to be read before
   * `nextCursor`: a failure carries no messages and no cursor of its own, so an
   * empty `messages` array from one is not the end of a session.
   */
  failure: 'retryable' | 'terminal' | null;
};

type SessionListQueryResult = Awaited<ReturnType<typeof trpcClient.cliSessionsV2.list.query>>;

/** A listed session row, cut down to the fields the mirror's index reads. */
type ArtifactSessionRow = Pick<
  SessionListQueryResult['cliSessions'][number],
  'session_id' | 'title' | 'updated_at'
>;

type ArtifactSessionListPage = {
  cliSessions: ArtifactSessionRow[];
  nextCursor: string | null;
};

/**
 * The page variant of a session's stored history, plus the typed failure
 * variants (`retryable_failure` | `too_large` | `invalid_data`) the crawl
 * surfaces on {@link MirrorMessagePage.failure} instead of paging past.
 * Declared here as the crawl's read model; the tRPC call in
 * {@link DEFAULT_DEPS} is what supplies the real one.
 */
type ArtifactMessageHistoryPage = {
  messages: unknown[];
  nextCursor: string | null;
};

type ArtifactMessageHistoryFailure = { kind: string };

type ArtifactSessionMessagesPage = {
  history: ArtifactMessageHistoryPage | ArtifactMessageHistoryFailure | null;
};

/**
 * The tRPC and filesystem work the crawl performs, injected so the whole crawl
 * runs in a unit test. Production callers omit it and get the real clients.
 */
export type ArtifactCrawlDeps = {
  downloadFile: (url: string, target: File) => Promise<File>;
  getSessionMessagesPage: (input: {
    cursor?: string;
    session_id: string;
  }) => Promise<ArtifactSessionMessagesPage>;
  listSessions: (input: {
    cursor?: string;
    limit: number;
    orderBy: 'updated_at';
  }) => Promise<ArtifactSessionListPage>;
  presignAttachmentDownload: (input: {
    filename: string;
    messageUuid: string;
  }) => Promise<{ signedUrl: string }>;
  /**
   * The byte length a URL declares before its body is downloaded, or null when
   * it does not say (or the probe fails). Used to reject an oversized artifact
   * before the whole response reaches device storage.
   */
  probeContentLength: (url: string) => Promise<number | null>;
};

/* eslint-disable @typescript-eslint/promise-function-async -- production passthroughs hand the tRPC/File promise back untouched */
const DEFAULT_DEPS: ArtifactCrawlDeps = {
  downloadFile: downloadAllowedArtifact,
  getSessionMessagesPage: input => trpcClient.cliSessionsV2.getSessionMessagesPage.query(input),
  listSessions: input => trpcClient.cliSessionsV2.list.query(input),
  presignAttachmentDownload: input =>
    trpcClient.cloudAgentNext.getAttachmentDownloadUrl.mutate(input),
  probeContentLength: url => probeContentLength(url),
};
/* eslint-enable @typescript-eslint/promise-function-async */

/**
 * Arm a deadline on `controller`: after `ms` the request it was given to is
 * aborted. The returned function cancels the timer, so the caller clears it on
 * every exit and no timer outlives the request it bounds.
 */
function abortAfter(controller: AbortController, ms: number): () => void {
  const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
    controller.abort();
  }, ms);
  return () => {
    clearTimeout(timer);
  };
}

/**
 * Settle with `work`, or reject as soon as `signal` aborts. `fetch` rejects a
 * pending request on abort, but a stream read or write it feeds takes no signal,
 * and a request whose transport ignores the abort would otherwise hang the
 * deadline. So the deadline is enforced here on the promise, not left to the
 * transport. The side that loses the race is abandoned, so its rejection is
 * kept handled, and the abort listener is removed once the race settles.
 */
async function raceAgainstAbort<T>(
  work: Promise<T>,
  signal: AbortSignal,
  message: string
): Promise<T> {
  const settled = Promise.withResolvers<T>();
  function settleWithError(error: unknown): void {
    settled.reject(error instanceof Error ? error : new Error(message));
  }
  // The work's own outcome, whichever it is: this helper only adds the deadline,
  // so a resolution and a rejection both pass through untouched. Awaiting here
  // keeps both failures handled, including the transfer the deadline abandoned.
  async function forwardWork(): Promise<void> {
    try {
      settled.resolve(await work);
    } catch (error) {
      settleWithError(error);
    }
  }
  function onAbort(): void {
    settleWithError(new Error(message));
  }
  // No await between the check and the listener, so an abort cannot be missed.
  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener('abort', onAbort, { once: true });
  }
  void forwardWork();
  try {
    return await settled.promise;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * The full byte length declared by a URL, or null when unknown.
 *
 * Attachment URLs are signed for GET, so HEAD would fail signature validation.
 * Request one byte and read the total from Content-Range, not the partial body's
 * Content-Length. Expo's streaming fetch lets us abort at the headers even if a
 * server ignores Range and sends a full response. Unknown lengths still get the
 * post-download size check below. A probe whose redirect chain leaves the
 * allowed origins reports nothing, and the probe itself is bounded by
 * {@link ARTIFACT_PROBE_TIMEOUT_MS}: a server that never answers makes the probe
 * report nothing rather than hold the artifact.
 */
async function probeContentLength(url: string): Promise<number | null> {
  const controller = new AbortController();
  const clearDeadline = abortAfter(controller, ARTIFACT_PROBE_TIMEOUT_MS);
  try {
    const response = await raceAgainstAbort(
      fetchAllowedArtifact(url, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        signal: controller.signal,
      }),
      controller.signal,
      'Artifact length probe timed out'
    );
    if (response === null || !response.ok) {
      return null;
    }
    const header =
      response.status === 206
        ? /^bytes \d+-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '')?.[1]
        : response.headers.get('content-length');
    if (header == null || !/^\d+$/.test(header)) {
      return null;
    }
    const declared = Number(header);
    return Number.isSafeInteger(declared) && declared >= 0 ? declared : null;
  } catch {
    return null;
  } finally {
    clearDeadline();
    // The deadline is the timer now, not this call: aborting here can only end a
    // probe that already has its headers. It is still needed, because a server
    // that ignores Range may be sending a body the probe never reads, and the
    // abort releases that stream.
    controller.abort();
  }
}

/** True only for an `https` URL on the artifact storage origin family. */
function isAllowedArtifactUrl(url: string): boolean {
  const authority = parseHttpUrlAuthority(url);
  if (authority?.protocol !== 'https' || authority.hasUserInfo) {
    return false;
  }
  // A non-default port would reach a service this allowlist says nothing about.
  if (authority.port !== '' && authority.port !== '443') {
    return false;
  }
  if (!authority.hostname.endsWith(ARTIFACT_HOST_SUFFIX)) {
    return false;
  }
  const accountLabel = authority.hostname.slice(
    0,
    authority.hostname.length - ARTIFACT_HOST_SUFFIX.length
  );
  return R2_ACCOUNT_LABEL.test(accountLabel);
}

/** The path and query of an `http(s)` URL, with the authority removed. */
function urlPathOf(url: string): string {
  const schemeEnd = url.indexOf('://');
  const remainder = url.slice(schemeEnd + 3);
  const authorityEnd = remainder.search(/[/?#\\]/);
  return authorityEnd === -1 ? '/' : remainder.slice(authorityEnd);
}

/** The path of an `http(s)` URL with its query and fragment removed. */
function basePathOf(path: string): string {
  const queryIndex = path.search(/[?#]/);
  return queryIndex === -1 ? path : path.slice(0, queryIndex);
}

/**
 * Resolve a relative reference against the path it answered for, per RFC 3986:
 * a leading `/` replaces the path, a leading `?` keeps it and replaces the
 * query, and anything else replaces the last segment. Dot segments resolve
 * against the origin root, so the result never climbs above it.
 */
function resolveRelativePath(from: string, target: string): string {
  const basePath = basePathOf(urlPathOf(from));
  const directory = basePath.endsWith('/')
    ? basePath
    : basePath.slice(0, basePath.lastIndexOf('/') + 1);
  let resolved = target;
  if (target.startsWith('?')) {
    resolved = `${basePath}${target}`;
  } else if (!target.startsWith('/')) {
    resolved = `${directory}${target}`;
  }
  const queryIndex = resolved.search(/[?#]/);
  const resolvedPath = queryIndex === -1 ? resolved : resolved.slice(0, queryIndex);
  const suffix = queryIndex === -1 ? '' : resolved.slice(queryIndex);
  const segments: string[] = [];
  for (const segment of resolvedPath.split('/')) {
    if (segment === '..') {
      segments.pop();
    } else if (segment !== '.') {
      segments.push(segment);
    }
  }
  const path = segments.join('/');
  return `${path.startsWith('/') ? path : `/${path}`}${suffix}`;
}

/**
 * The URL a redirect's `Location` points at, or null when it must not be
 * followed.
 *
 * An absolute target is adjudicated on its own. A relative one is resolved
 * against the URL it answered for, while the origin stays the one already
 * validated, so a hop can be followed without leaving that origin.
 */
function allowedRedirectTarget(from: string, location: string | null): string | null {
  if (location === null) {
    return null;
  }
  const target = location.trim().replaceAll('\\', '/');
  if (target === '') {
    return null;
  }
  // A scheme-relative reference names its own host, so it is adjudicated like
  // an absolute one.
  if (target.startsWith('//')) {
    const absolute = `https:${target}`;
    return isAllowedArtifactUrl(absolute) ? absolute : null;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    return isAllowedArtifactUrl(target) ? target : null;
  }
  const origin = parseHttpUrlAuthority(from);
  if (origin === null) {
    return null;
  }
  const authority = origin.port === '' ? origin.hostname : `${origin.hostname}:${origin.port}`;
  return `https://${authority}${resolveRelativePath(from, target)}`;
}

/**
 * Issue a GET to the origin the artifact came from: `url` is either one
 * {@link isAllowedArtifactUrl} accepted or the signed URL the presign call just
 * returned for the caller's own message, and each redirect the response answers
 * with is adjudicated by {@link allowedRedirectTarget} before it is followed.
 * Null means the artifact is not fetched; every request in the chain then names
 * a host the allowlist covers.
 */
async function fetchAllowedArtifact(
  url: string,
  init: RequestInit,
  hop = 0
): Promise<Response | null> {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  const isRedirect =
    response.status === 301 ||
    response.status === 302 ||
    response.status === 303 ||
    response.status === 307 ||
    response.status === 308;
  if (!isRedirect) {
    return response;
  }
  const next =
    hop < MAX_ARTIFACT_REDIRECTS
      ? allowedRedirectTarget(url, response.headers.get('location'))
      : null;
  await response.body?.cancel();
  return next === null ? null : fetchAllowedArtifact(next, init, hop + 1);
}

/**
 * Start a stream teardown without waiting for it. A transport that ignores
 * `cancel()`, or a sink that never runs `abort()`, must not hold a lost
 * deadline open, so the release is detached and its rejection swallowed: the
 * transfer's own failure is what the caller has to see.
 */
function releaseQuietly(release: Promise<unknown>): void {
  void (async () => {
    try {
      await release;
    } catch {
      // The stream is left as its transport ended it.
    }
  })();
}

/**
 * Move one response body into one write stream, releasing both ends on any
 * failure. The two ends are owned here — a reader and a writer acquired
 * explicitly — rather than handed to `pipeTo`, which takes no signal: a pipe
 * raced against the deadline stays locked after the race is lost, so the
 * abandoned transfer could neither cancel the body nor abort the file handle,
 * and the stall this bounds would hold the file open. Reading and writing in
 * this loop lets each step settle against the abort, and lets the failure path
 * below release both ends itself.
 *
 * Release never waits: a transport that ignores `cancel()` must not keep the
 * deadline open, so the teardown promises are started and their rejections
 * swallowed. Both locks are dropped afterwards, so a later attempt can reuse the
 * streams and no release outlives the transfer.
 */
async function pumpArtifactBody(
  body: ReadableStream<Uint8Array>,
  destination: WritableStream<Uint8Array>,
  signal: AbortSignal
): Promise<void> {
  const reader = body.getReader();
  const writer = destination.getWriter();
  try {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- a stream is read one chunk after the previous one, which is the whole point
      const { done, value } = await raceAgainstAbort(
        reader.read(),
        signal,
        'Artifact download timed out'
      );
      if (done) {
        break;
      }
      // eslint-disable-next-line no-await-in-loop -- each chunk is written before the next is read, so the body never sits in memory whole
      await raceAgainstAbort(writer.write(value), signal, 'Artifact download timed out');
    }
    await raceAgainstAbort(writer.close(), signal, 'Artifact download timed out');
  } catch (error) {
    // A transfer the deadline raced out has nothing observing its other side, so
    // both ends are released here. Neither release is awaited: the file handle
    // must come back even from a transport that never answers, and the original
    // failure is what the caller must see.
    releaseQuietly(reader.cancel());
    releaseQuietly(writer.abort());
    throw error;
  } finally {
    releaseLockQuietly(reader);
    releaseLockQuietly(writer);
  }
}

/**
 * Drop a reader's or writer's lock so the stream can be used again. A stream
 * still tearing down after the deadline may refuse the release; the lock then
 * belongs to the abandoned stream, and nothing the caller does with it, so a
 * refusal must not raise over the transfer's own failure.
 */
function releaseLockQuietly(lock: { releaseLock: () => void }): void {
  try {
    lock.releaseLock();
  } catch {
    // The lock stays with the abandoned stream.
  }
}

/**
 * Download an allowed artifact URL into `target`, following only redirects that
 * stay on the allowed origins; a refused hop leaves no bytes behind. The body
 * streams through the file handle one chunk at a time, so a download never sits
 * in memory whole, and {@link pumpArtifactBody} owns both ends of the transfer
 * so every failure releases the file handle as well as the body.
 *
 * The whole transfer — headers and body — is bounded by
 * {@link ARTIFACT_DOWNLOAD_TIMEOUT_MS} through one controller whose signal
 * reaches every redirect hop and every step of the pump. An aborted transfer
 * becomes the retryable `download-failed` through {@link materializeArtifact},
 * so the cursor is held and the artifact is retried on the next run instead of
 * stalling it forever.
 */
async function downloadAllowedArtifact(url: string, target: File): Promise<File> {
  const controller = new AbortController();
  const clearDeadline = abortAfter(controller, ARTIFACT_DOWNLOAD_TIMEOUT_MS);
  let response: Response | null = null;
  // A body this function still owes a release for: set once the status is kept
  // and cleared as soon as the pump owns it. The pump releases its own ends, so
  // only a body no pump acquired is left to the catch below.
  let unattachedBody: ReadableStream<Uint8Array> | null = null;
  try {
    response = await raceAgainstAbort(
      fetchAllowedArtifact(url, { method: 'GET', signal: controller.signal }),
      controller.signal,
      'Artifact download timed out'
    );
    if (response === null) {
      throw new Error('Artifact download address is not an allowed origin');
    }
    if (!response.ok) {
      // The caller keeps no bytes from a failed status, so release the body rather
      // than leaving the connection's stream unread.
      await response.body?.cancel();
      throw new Error(`Artifact download failed with status ${response.status}`);
    }
    const body = response.body ?? new Blob([]).stream();
    unattachedBody = body;
    // `writableStream()` opens a write-only handle: iOS throws when the file does
    // not exist, and neither platform truncates there. Creating it first makes
    // the staging path a fresh empty file, so a leftover of the same name cannot
    // leave a tail behind the new bytes.
    target.create({ intermediates: true, overwrite: true });
    const destination = target.writableStream();
    // Both ends are acquired, so the pump takes the body over from here: it
    // aborts the destination and cancels the body itself, and no failed transfer
    // is left holding the file handle.
    unattachedBody = null;
    await pumpArtifactBody(body, destination, controller.signal);
    return target;
  } catch (error) {
    // A body no pump acquired has never been read, so release it here. A transport
    // that ignores cancel must not keep this failure waiting, so the release is
    // started and not awaited, and its rejection is swallowed.
    if (unattachedBody !== null) {
      releaseQuietly(unattachedBody.cancel());
    }
    deleteQuietly(target);
    throw error;
  } finally {
    clearDeadline();
  }
}

// `messages` comes off tRPC as a trusted-shaped but statically unknown payload,
// so the walk asserts each level once instead of re-parsing the shared contract.
// A field the schema guarantees (id, mime, type, url) is asserted present; a
// genuinely optional one (filename, state, attachments) stays optional.
type LooseAttachment = { filename?: string; mime: string; url: string };
type LooseToolState = { attachments?: LooseAttachment[]; status: string };
type LoosePart = {
  filename?: string;
  id: string;
  mime: string;
  state?: LooseToolState;
  tool?: string;
  type: string;
  url?: string;
};
type LooseMessage = { parts?: LoosePart[] };

/**
 * Walk stored session messages and collect the artifacts the mirror should
 * show. Mirrors the live sink's predicate exactly
 * (`packages/cloud-agent-sdk/src/chat-processor.ts`).
 */
export function extractSessionArtifacts(messages: unknown[]): CrawledArtifact[] {
  const artifacts: CrawledArtifact[] = [];
  for (const message of messages) {
    for (const part of loosePartsOf(message)) {
      collectPartArtifacts(part, artifacts);
    }
  }
  return artifacts;
}

/**
 * Read one message's parts. An absent part list (and a non-object message) is
 * an empty list rather than an error: stored history may hold either.
 */
function loosePartsOf(message: unknown): LoosePart[] {
  if (!message) {
    return [];
  }
  const parts = (message as LooseMessage).parts;
  return Array.isArray(parts) ? parts : [];
}

/**
 * Write one artifact's bytes into `target` and report its size. An artifact
 * over {@link MAX_ARTIFACT_BYTES} is rejected from its declared length before
 * the transfer, and from the received size when the length was not declared.
 * Never throws: one unreachable artifact must not end the run, and the next run
 * retries it.
 */
export async function materializeArtifact(
  artifact: CrawledArtifact,
  target: File,
  deps?: Partial<ArtifactCrawlDeps>
): Promise<ArtifactMaterializeResult> {
  if (artifact.url.startsWith('data:')) {
    return writeDataUrlArtifact(artifact, target);
  }

  const resolved = resolveDeps(deps);
  const downloadUrl = await resolveDownloadUrl(artifact.url, resolved);
  if ('failure' in downloadUrl) {
    return { ok: false, reason: downloadUrl.failure };
  }

  // Reject an oversized artifact from its declared length before the body is
  // written: the post-download check below only runs once the whole response
  // has already reached device storage. A probe that reports nothing is not a
  // reason to skip the download; the size check still catches it afterwards.
  const declaredSize = await resolved.probeContentLength(downloadUrl.url);
  if (declaredSize !== null && declaredSize > MAX_ARTIFACT_BYTES) {
    return { ok: false, reason: 'too-large' };
  }

  try {
    const downloaded = await resolved.downloadFile(downloadUrl.url, target);
    if (downloaded.size > MAX_ARTIFACT_BYTES) {
      deleteQuietly(target);
      return { ok: false, reason: 'too-large' };
    }
    return { ok: true, size: downloaded.size };
  } catch {
    return { ok: false, reason: 'download-failed' };
  }
}

/** One page of the signed-in user's sessions, newest first. */
export async function listSessionPage(
  input: { cursor?: string | null },
  deps?: Partial<ArtifactCrawlDeps>
): Promise<MirrorSessionPage> {
  const cursor = input.cursor ?? undefined;
  const result = await resolveDeps(deps).listSessions({
    limit: MIRROR_SESSION_LIMIT,
    orderBy: 'updated_at',
    ...(cursor ? { cursor } : {}),
  });
  return {
    nextCursor: result.nextCursor,
    sessions: result.cliSessions.map(row => ({
      id: row.session_id,
      title: row.title,
      updatedAt: row.updated_at,
    })),
  };
}

/**
 * One page of a session's stored messages. A typed failure variant yields no
 * messages and returns the cursor it was given, and says so on `failure`: the
 * caller can then tell a failed page from a session that truly ended, and retry
 * the same page instead of recording the session as crawled.
 */
export async function fetchSessionMessagesPage(
  input: { cursor?: string | null; sessionId: string },
  deps?: Partial<ArtifactCrawlDeps>
): Promise<MirrorMessagePage> {
  const cursor = input.cursor ?? undefined;
  const result = await resolveDeps(deps).getSessionMessagesPage({
    session_id: input.sessionId,
    ...(cursor ? { cursor } : {}),
  });

  const history = result.history;
  if (history !== null && 'messages' in history) {
    return { failure: null, messages: history.messages, nextCursor: history.nextCursor };
  }
  if (history === null) {
    // A session with no stored history at all is a real empty page, not a
    // failure: the run may record it as crawled.
    return { failure: null, messages: [], nextCursor: null };
  }
  return {
    failure: history.kind === 'retryable_failure' ? 'retryable' : 'terminal',
    messages: [],
    nextCursor: cursor ?? null,
  };
}

/**
 * Assemble the mirror's session entries. A session keeps its folder even with
 * no files. Its label is sanitized ({@link safeArtifactSessionName}) rather than
 * taken verbatim: the title is free text, and both file browsers need one
 * non-empty path component, with `Session <id>` as the fallback. The title is
 * first gated through {@link sessionDisplayTitle}, so a row still carrying the
 * backend's `New session - <ISO>` placeholder gets the fallback label instead
 * of the machine string the app itself would never paint. Duplicate filenames
 * within a session are disambiguated by {@link uniqueArtifactDisplayNames}, so
 * the browser shows one row per artifact.
 */
export function buildSessionArtifacts(
  sessions: MirrorSessionRow[],
  artifactsBySession: ReadonlyMap<string, MaterializedArtifact[]>
): ArtifactMirrorSession[] {
  return sessions.map(session => ({
    id: session.id,
    title: safeArtifactSessionName({
      id: session.id,
      title: sessionDisplayTitle(session.title) ?? null,
    }),
    updatedAt: session.updatedAt,
    files: uniqueArtifactDisplayNames(
      (artifactsBySession.get(session.id) ?? []).map(artifact => toMirrorFile(artifact))
    ),
  }));
}

function resolveDeps(deps?: Partial<ArtifactCrawlDeps>): ArtifactCrawlDeps {
  return { ...DEFAULT_DEPS, ...deps };
}

/**
 * Turn a stored URL into something downloadable: presign a sandbox reference,
 * accept a URL on the artifact storage origin family, and report any other value
 * as unsupported. A failed presign is a download failure, not an unsupported
 * URL. Those two sources are the hosted artifacts the mirror materializes.
 */
async function resolveDownloadUrl(
  url: string,
  deps: ArtifactCrawlDeps
): Promise<{ url: string } | { failure: ArtifactMaterializeFailure }> {
  const ref = parseCloudAgentAttachmentUrl(url);
  if (ref) {
    try {
      const signed = await deps.presignAttachmentDownload({
        filename: ref.filename,
        messageUuid: ref.messageUuid,
      });
      return { url: signed.signedUrl };
    } catch {
      return { failure: 'download-failed' };
    }
  }
  if (isAllowedArtifactUrl(url)) {
    return { url };
  }
  return { failure: 'unsupported' };
}

function collectPartArtifacts(part: LoosePart, artifacts: CrawledArtifact[]): void {
  if (part.type === 'file') {
    if (part.url !== undefined && part.url !== '') {
      artifacts.push({
        id: part.id,
        mime: part.mime,
        ...(part.filename ? { filename: part.filename } : {}),
        url: part.url,
      });
    }
    return;
  }

  if (part.type !== 'tool' || part.state?.status !== 'completed') {
    return;
  }
  const attachments = part.state.attachments;
  if (!Array.isArray(attachments)) {
    return;
  }

  for (let index = 0; index < attachments.length; index += 1) {
    const attachment = attachments[index];
    if (attachment && attachment.url !== '' && keepsAttachment(part, attachment)) {
      artifacts.push({
        id: index === 0 ? part.id : `${part.id}-${index}`,
        mime: attachment.mime,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
        url: attachment.url,
      });
    }
  }
}

/** The live sink's attachment predicate: images always, other files via send_file. */
function keepsAttachment(part: LoosePart, attachment: LooseAttachment): boolean {
  return attachment.mime.startsWith('image/') || part.tool === 'send_file';
}

async function writeDataUrlArtifact(
  artifact: CrawledArtifact,
  target: File
): Promise<ArtifactMaterializeResult> {
  const payload = stripDataUrlBase64Prefix(artifact.url, artifact.mime);
  if (payload === undefined) {
    return { ok: false, reason: 'unsupported' };
  }
  const size = base64DecodedByteLength(payload);
  if (size > MAX_ARTIFACT_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  try {
    await target.write(payload, { encoding: 'base64' });
  } catch {
    return { ok: false, reason: 'download-failed' };
  }
  return { ok: true, size };
}

function toMirrorFile(artifact: MaterializedArtifact): ArtifactMirrorFile {
  return {
    id: artifact.id,
    name: safeArtifactDisplayName({
      id: artifact.id,
      name: artifact.filename ?? '',
      mime: artifact.mime,
    }),
    mime: artifact.mime,
    size: artifact.size,
  };
}

/** Decoded byte count of a base64 payload, from its length and padding. */
function base64DecodedByteLength(payload: string): number {
  let padding = 0;
  if (payload.endsWith('==')) {
    padding = 2;
  } else if (payload.endsWith('=')) {
    padding = 1;
  }
  return Math.floor((payload.length * 3) / 4) - padding;
}

function deleteQuietly(file: File): void {
  try {
    file.delete();
  } catch {
    // The next run's prune removes an oversize file that could not be deleted.
  }
}

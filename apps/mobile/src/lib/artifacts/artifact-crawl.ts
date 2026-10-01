/* eslint-disable max-lines -- the crawl reads the session tree, bounds and materializes bytes, and assembles the mirror entries as one cohesive module */
import { File } from 'expo-file-system';
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
  downloadFile: (url, target) => File.downloadFileAsync(url, target, { idempotent: true }),
  getSessionMessagesPage: input => trpcClient.cliSessionsV2.getSessionMessagesPage.query(input),
  listSessions: input => trpcClient.cliSessionsV2.list.query(input),
  presignAttachmentDownload: input =>
    trpcClient.cloudAgentNext.getAttachmentDownloadUrl.mutate(input),
  probeContentLength: url => probeContentLength(url),
};
/* eslint-enable @typescript-eslint/promise-function-async */

/**
 * The full byte length declared by a URL, or null when unknown.
 *
 * Attachment URLs are signed for GET, so HEAD would fail signature validation.
 * Request one byte and read the total from Content-Range, not the partial body's
 * Content-Length. Expo's streaming fetch lets us abort at the headers even if a
 * server ignores Range and sends a full response. Unknown lengths still get the
 * post-download size check below.
 */
async function probeContentLength(url: string): Promise<number | null> {
  const controller = new AbortController();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal,
    });
    if (!response.ok) {
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
    controller.abort();
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
 * accept an `http(s)` URL as-is, and report anything else as unsupported. A
 * failed presign is a download failure, not an unsupported URL.
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
  if (isHttpUrl(url)) {
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

function writeDataUrlArtifact(artifact: CrawledArtifact, target: File): ArtifactMaterializeResult {
  const payload = stripDataUrlBase64Prefix(artifact.url, artifact.mime);
  if (payload === undefined) {
    return { ok: false, reason: 'unsupported' };
  }
  const size = base64DecodedByteLength(payload);
  if (size > MAX_ARTIFACT_BYTES) {
    return { ok: false, reason: 'too-large' };
  }
  try {
    target.write(payload, { encoding: 'base64' });
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

function isHttpUrl(url: string): boolean {
  return url.startsWith('http://') || url.startsWith('https://');
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

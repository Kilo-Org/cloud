import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@kilocode/cloud-agent-sdk/limits';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { type ShareIntent } from 'expo-share-intent';

import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';
import type * as DraftsModule from '@/lib/persist/drafts';
import { registerTempFile } from '@/lib/temp-file-registry';

// Durable persistence of the in-memory payload store (DEC-01 drafts). Loaded
// lazily via dynamic import so unit tests that only touch the in-memory map or
// the pure helpers do not load encrypted-kv (expo-sqlite/drizzle) at import
// time (same reasoning as lib/deep-link-launch.ts).

let draftsPromise: Promise<typeof DraftsModule> | null = null;

// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function getDrafts(): Promise<typeof DraftsModule> {
  draftsPromise ??= import('@/lib/persist/drafts');
  return draftsPromise;
}

export type ShareId = string;

export type SharePayload = {
  text: string;
  files: AgentAttachmentCandidate[];
  /** Names of incoming files whose cache copy threw; empty when none failed. */
  failedFiles: string[];
};

/** The cloud agent prompt cap; the composer clamps again on delivery. */
export const SHARE_TEXT_MAX_CHARS = CLOUD_AGENT_PROMPT_MAX_LENGTH;

export const SHARE_PAYLOAD_MAX_ENTRIES = 5;

type ShareIntentLike = Pick<ShareIntent, 'text' | 'webUrl' | 'meta' | 'files'>;

type CopyToCache = (args: { from: string; fileName: string }) => Promise<string>;

type DeleteCachedFile = (uri: string) => void | Promise<void>;

/**
 * One staged payload and the account that staged it. A null `stagedUserId` is
 * a share captured while signed out: it is memory-only (DEC-01), carries no
 * account data, and outlives the account boundary so a same-process sign-in
 * can still open the gate for it.
 */
type StagedSharePayload = { payload: SharePayload; stagedUserId: string | null };

const payloads = new Map<ShareId, StagedSharePayload>();
const insertionOrder: ShareId[] = [];

/** Listeners the account boundary notifies after it dropped staged payloads. */
const accountStagedClearListeners = new Set<() => void>();

// Signed-in user id that scopes durable persistence. When null, every
// persist/clear helper no-ops (DEC-01 account scope): a share captured while
// signed out stays in-memory only so a same-process login can still open the
// gate. `_layout.tsx` sets this on identity transitions.
let sharePersistUserId: string | null = null;

/** Sets the signed-in user id that scopes share persistence (null = signed out). */
export function setSharePersistUserId(userId: string | null): void {
  sharePersistUserId = userId;
}

/** Current persist-scoped user id, shared with share-navigation. */
export function getSharePersistUserId(): string | null {
  return sharePersistUserId;
}

function defaultDeleteCachedFile(uri: string): void {
  try {
    // The modern File API deletes synchronously; a missing file is a no-op.
    const file = new File(uri);
    if (file.exists) {
      file.delete();
    }
  } catch {
    // Best-effort hygiene; ignore delete failures.
  }
}

let deleteCachedFile: DeleteCachedFile = defaultDeleteCachedFile;

type FileExists = (uri: string) => boolean;

function defaultFileExists(uri: string): boolean {
  try {
    // `File.exists` is false for a directory path, so the `!isDirectory` guard
    // the legacy `getInfoAsync` needed is implicit.
    return new File(uri).exists;
  } catch {
    return false;
  }
}

let checkFileExists: FileExists = defaultFileExists;

/** Fire-and-forget delete of each file uri in a dropped payload. */
function discardPayloadCacheFiles(payload: SharePayload): void {
  for (const file of payload.files) {
    void deleteCachedFile(file.uri);
  }
}

/** Best-effort delete of copies for a payload that never entered the store. */
export function discardUnstoredSharePayload(payload: SharePayload): void {
  discardPayloadCacheFiles(payload);
}

/** Snapshot of the in-memory store in the persisted draft shape. */
function sharePayloadsDraftSnapshot() {
  const order = [...insertionOrder];
  const entries: Record<
    ShareId,
    { text: string; files: { name: string; uri: string }[]; failedFiles: string[] }
  > = {};
  for (const [id, entry] of payloads) {
    entries[id] = {
      text: entry.payload.text,
      files: entry.payload.files.map(file => ({ name: file.name, uri: file.uri })),
      failedFiles: [...entry.payload.failedFiles],
    };
  }
  return { order, entries };
}

/**
 * Persists the current in-memory payload store (debounced + flushed) so it
 * survives process death. No-ops while signed out (DEC-01 account scope).
 */
export async function persistSharePayloadsNow(): Promise<void> {
  const userId = sharePersistUserId;
  if (!userId) {
    return;
  }
  const { saveDraft, flushDraft, SHARE_PAYLOADS_DRAFT_KEY } = await getDrafts();
  saveDraft(userId, SHARE_PAYLOADS_DRAFT_KEY, sharePayloadsDraftSnapshot());
  await flushDraft(userId, SHARE_PAYLOADS_DRAFT_KEY);
}

/**
 * Clears the durable pending-share-id hint only when it still names `id`.
 * The durable remove is value-scoped in the storage layer (compare inside the
 * serialized chain), so clearing/taking share A never drops share B's durable
 * pending id even when B is written concurrently and not yet flushed. No-op
 * while signed out.
 *
 * Called by the share gate's commit so a process kill between commit and
 * navigation delivery never re-arms the gate (the pending id is the only
 * thing the cold-start restore reads to re-open it). The payload itself is
 * intentionally left staged: the navigator still needs it to deliver.
 */
export async function clearPendingShareIdDraft(id: ShareId): Promise<void> {
  const userId = sharePersistUserId;
  if (!userId) {
    return;
  }
  const { clearDraftIfStill, PENDING_SHARE_ID_DRAFT_KEY } = await getDrafts();
  await clearDraftIfStill(userId, PENDING_SHARE_ID_DRAFT_KEY, JSON.stringify(id));
}

function evictOldestIfNeeded(): void {
  while (payloads.size > SHARE_PAYLOAD_MAX_ENTRIES && insertionOrder.length > 0) {
    const oldest = insertionOrder.shift();
    if (oldest !== undefined) {
      const evicted = payloads.get(oldest);
      payloads.delete(oldest);
      if (evicted) {
        discardPayloadCacheFiles(evicted.payload);
      }
    }
  }
  void persistSharePayloadsNow();
}

/** Adds an entry and returns its id. Evicts oldest beyond SHARE_PAYLOAD_MAX_ENTRIES. */
export function putSharePayload(payload: SharePayload): ShareId {
  const id = Crypto.randomUUID();
  payloads.set(id, { payload, stagedUserId: sharePersistUserId });
  insertionOrder.push(id);
  evictOldestIfNeeded();
  void persistSharePayloadsNow();
  return id;
}

/**
 * Read-and-delete map entry only. Never deletes cache files here — the
 * composer's uploads still read those uris after take. Consuming the payload
 * also clears the durable pending-share-id hint so the gate never re-opens.
 */
export function takeSharePayload(id: ShareId): SharePayload | null {
  const entry = payloads.get(id);
  if (entry === undefined) {
    return null;
  }
  payloads.delete(id);
  const index = insertionOrder.indexOf(id);
  if (index !== -1) {
    insertionOrder.splice(index, 1);
  }
  void persistSharePayloadsNow();
  void clearPendingShareIdDraft(id);
  return entry.payload;
}

/**
 * Put a payload back under the id it was taken with, after a delivery that
 * threw. The route keeps its `shareId`, so the next mount of that route (the
 * composer's own Retry) delivers the same files again instead of showing an
 * empty composer. Re-insertion re-files the id at the newest position and
 * evicts the oldest past the cap, so a restored payload lives exactly as long
 * as a freshly staged one.
 */
export function restoreSharePayload(id: ShareId, payload: SharePayload): void {
  if (payloads.has(id)) {
    return;
  }
  payloads.set(id, { payload, stagedUserId: sharePersistUserId });
  insertionOrder.push(id);
  evictOldestIfNeeded();
}

/** Read-only, for the gate's own preview. */
export function peekSharePayload(id: ShareId): SharePayload | null {
  return payloads.get(id)?.payload ?? null;
}

/** Id-scoped abandonment. Never clears another id's entry. */
export function clearSharePayload(id: ShareId): void {
  const entry = payloads.get(id);
  if (entry === undefined) {
    return;
  }
  payloads.delete(id);
  const index = insertionOrder.indexOf(id);
  if (index !== -1) {
    insertionOrder.splice(index, 1);
  }
  discardPayloadCacheFiles(entry.payload);
  void persistSharePayloadsNow();
  void clearPendingShareIdDraft(id);
}

/**
 * Restores the payloads map from the durable draft for `userId`. Fills the
 * store first (in recorded order), then reconciles each file against the
 * filesystem: a missing cache copy moves its name into `failedFiles` and is
 * dropped from `files`. Fills ONLY an empty store, so a live share staged in
 * this process (cold-start share-to-app, or a signed-out share then
 * same-process login) is never clobbered by a stale or empty draft.
 */
export async function restoreSharePayloads(userId: string): Promise<void> {
  if (!userId) {
    return;
  }
  const { loadDraft, SHARE_PAYLOADS_DRAFT_KEY, isSharePayloadsDraft } = await getDrafts();
  const draft = await loadDraft(userId, SHARE_PAYLOADS_DRAFT_KEY, isSharePayloadsDraft);

  // The identity can change while the draft read is in flight, and a restore
  // belongs to the account it started for. When the persist scope moved, this
  // read returns without filling the store.
  if (sharePersistUserId !== userId) {
    return;
  }

  // Fill only an empty store. The check runs after the read settles so a put
  // that lands during the read also wins, and it must not be replaced with an
  // early "no draft" return: a take/clear persists a truthy empty draft
  // (`{ order: [], entries: {} }`) that must not wipe live in-memory shares.
  if (payloads.size > 0) {
    return;
  }
  if (!draft) {
    return;
  }

  // Fill first, keeping every recorded id in order.
  payloads.clear();
  insertionOrder.length = 0;
  for (const id of draft.order) {
    const entry = draft.entries[id];
    if (entry) {
      payloads.set(id, {
        payload: {
          text: entry.text,
          files: entry.files.map(file => ({ name: file.name, uri: file.uri })),
          failedFiles: [...entry.failedFiles],
        },
        stagedUserId: userId,
      });
      insertionOrder.push(id);
    }
  }

  // Then reconcile each file against the filesystem.
  for (const { payload } of payloads.values()) {
    const kept: AgentAttachmentCandidate[] = [];
    const failed = [...payload.failedFiles];
    for (const file of payload.files) {
      if (checkFileExists(file.uri)) {
        kept.push(file);
      } else {
        failed.push(file.name);
      }
    }
    payload.files.length = 0;
    payload.files.push(...kept);
    payload.failedFiles.length = 0;
    payload.failedFiles.push(...failed);
  }
}

/**
 * Drop every payload staged under a signed-in account, with its cache copies.
 * The account boundary (sign-out and a direct account switch) calls this, so
 * staged share state belongs to exactly one account session: entries stamped
 * with that account leave with it.
 *
 * A payload staged while signed out keeps its place (DEC-01 account scope): it
 * is memory-only, and a same-process sign-in still opens the gate for it. This
 * call never persists; it runs at a boundary, not inside an account session.
 * An account's own draft keeps the staged share for that account's next
 * sign-in.
 */
export function clearAccountStagedSharePayloads(): void {
  const dropped = [...payloads].filter(([, entry]) => entry.stagedUserId !== null);
  for (const [id, entry] of dropped) {
    payloads.delete(id);
    const index = insertionOrder.indexOf(id);
    if (index !== -1) {
      insertionOrder.splice(index, 1);
    }
    discardPayloadCacheFiles(entry.payload);
  }
  if (dropped.length === 0) {
    return;
  }
  // The pending slot lives in the root layout and resets with the payloads, so
  // the shell and the store always describe the same staged share.
  for (const listener of accountStagedClearListeners) {
    listener();
  }
}

/**
 * Subscribe to the account boundary dropping staged payloads. The root layout
 * uses it to reset its pending share id; it fires only when a stamped entry
 * was dropped, so a capture staged before an account resolves keeps its slot.
 */
export function subscribeAccountStagedShareClear(listener: () => void): () => void {
  accountStagedClearListeners.add(listener);
  return () => {
    accountStagedClearListeners.delete(listener);
  };
}

/** Test-only: wipe the module store between cases. */
export function __resetSharePayloadStoreForTests(): void {
  payloads.clear();
  insertionOrder.length = 0;
  accountStagedClearListeners.clear();
  deleteCachedFile = defaultDeleteCachedFile;
  checkFileExists = defaultFileExists;
  sharePersistUserId = null;
}

/** Test-only: replace the cache-file delete implementation. */
export function __setDeleteCachedFileForTests(fn: DeleteCachedFile | null): void {
  deleteCachedFile = fn ?? defaultDeleteCachedFile;
}

/** Test-only: replace the file-existence check used by restore. */
export function __setCheckFileExistsForTests(fn: FileExists | null): void {
  checkFileExists = fn ?? defaultFileExists;
}

export function composeShareText(shareIntent: ShareIntentLike): string {
  let base = (shareIntent.text ?? '').trim();
  if (base === '' && shareIntent.webUrl) {
    base = shareIntent.webUrl;
  }
  const title = shareIntent.meta?.title?.trim();
  if (title && base !== '' && !base.includes(title)) {
    base = `${title}\n${base}`;
  }
  if (base.length > SHARE_TEXT_MAX_CHARS) {
    return base.slice(0, SHARE_TEXT_MAX_CHARS);
  }
  return base;
}

async function defaultCopyToCache(args: { from: string; fileName: string }): Promise<string> {
  const safeName = args.fileName.replaceAll(/[/\\]/g, '_') || 'shared-file';
  const destination = new File(Paths.cache, `share-${Crypto.randomUUID()}-${safeName}`);
  await new File(args.from).copy(destination);
  registerTempFile(destination.uri);
  return destination.uri;
}

export async function normalizeShareIntent(
  shareIntent: ShareIntentLike,
  copyToCache: CopyToCache = defaultCopyToCache
): Promise<SharePayload> {
  const text = composeShareText(shareIntent);
  const incomingFiles = shareIntent.files ?? [];
  const outcomes = await Promise.all(
    incomingFiles.map(async file => {
      const name = file.fileName || 'shared-file';
      try {
        const uri = await copyToCache({ from: file.path, fileName: name });
        const candidate: AgentAttachmentCandidate = { name, uri };
        if (file.mimeType) {
          candidate.mimeType = file.mimeType;
        }
        if (file.size != null) {
          candidate.size = file.size;
        }
        return { ok: true as const, candidate };
      } catch {
        // Drop only this file; text and other successful copies still count.
        // Name is kept so the gate preview can surface the silent loss.
        return { ok: false as const, name };
      }
    })
  );
  const files: AgentAttachmentCandidate[] = [];
  const failedFiles: string[] = [];
  for (const outcome of outcomes) {
    if (outcome.ok) {
      files.push(outcome.candidate);
    } else {
      failedFiles.push(outcome.name);
    }
  }

  // A share whose copies all failed is a recoverable outcome, not an error:
  // the payload carries the failed names, and the gate's all-rejected state
  // reports them and offers no session to start. Text and any successful copy
  // still count.
  return { text, files, failedFiles };
}

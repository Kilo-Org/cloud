/* eslint-disable max-lines -- the in-memory store, its durable draft snapshot, the account boundary, and the cache-file hygiene share one module so their scope rules stay in one place */
import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@kilocode/cloud-agent-sdk/limits';
import * as Crypto from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import { type ShareIntent } from 'expo-share-intent';

import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';
import type * as DraftsModule from '@/lib/persist/drafts';
import { captureTelemetry } from '@/lib/telemetry/error-sink';
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
export type StagedSharePayload = { payload: SharePayload; stagedUserId: string | null };

const payloads = new Map<ShareId, StagedSharePayload>();
const insertionOrder: ShareId[] = [];

/**
 * Listeners the account boundary notifies after it dropped staged payloads,
 * with the ids it dropped so a subscriber can tell whether its own slot still
 * names a staged entry.
 */
const accountStagedClearListeners = new Set<(droppedIds: readonly ShareId[]) => void>();

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

/**
 * Snapshot of the payloads staged under `userId` in the persisted draft shape.
 * A capture staged before an account resolved is left out: it is memory-only
 * (DEC-01), so it can never be restored under an account that did not stage it.
 */
function sharePayloadsDraftSnapshot(userId: string) {
  const order = insertionOrder.filter(id => payloads.get(id)?.stagedUserId === userId);
  const entries: Record<
    ShareId,
    { text: string; files: { name: string; uri: string }[]; failedFiles: string[] }
  > = {};
  for (const id of order) {
    const entry = payloads.get(id);
    if (entry !== undefined) {
      entries[id] = {
        text: entry.payload.text,
        files: entry.payload.files.map(file => ({ name: file.name, uri: file.uri })),
        failedFiles: [...entry.payload.failedFiles],
      };
    }
  }
  return { order, entries };
}

/**
 * Persists the payloads staged under the signed-in account (debounced + flushed)
 * so they survive process death. No-ops while signed out, and never writes a
 * capture that the account did not stage (DEC-01 account scope).
 */
export async function persistSharePayloadsNow(): Promise<void> {
  const userId = sharePersistUserId;
  if (!userId) {
    return;
  }
  const { saveDraft, flushDraft, SHARE_PAYLOADS_DRAFT_KEY } = await getDrafts();
  saveDraft(userId, SHARE_PAYLOADS_DRAFT_KEY, sharePayloadsDraftSnapshot(userId));
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

/**
 * Persists the pending-share-id draft for `userId` and flushes it so a
 * process death before the gate opens still restores the share. This module
 * owns the draft key (`PENDING_SHARE_ID_DRAFT_KEY`, lazily loaded with the
 * other drafts helpers), the value shape (a JSON string holding the
 * {@link ShareId}), and the flush requirement; `clearPendingShareIdDraft` is
 * the matching clear.
 */
export async function persistPendingShareIdDraft(userId: string, shareId: ShareId): Promise<void> {
  const { saveDraft, flushDraft, PENDING_SHARE_ID_DRAFT_KEY } = await getDrafts();
  saveDraft(userId, PENDING_SHARE_ID_DRAFT_KEY, shareId);
  await flushDraft(userId, PENDING_SHARE_ID_DRAFT_KEY);
}

/**
 * Reads the pending-share-id draft for `userId` and returns it, or null when
 * nothing usable is stored. Same owner as `persistPendingShareIdDraft` and
 * `clearPendingShareIdDraft`: only this module touches the key.
 */
export async function loadPendingShareIdDraft(userId: string): Promise<ShareId | null> {
  const { loadDraft, isStringDraft, PENDING_SHARE_ID_DRAFT_KEY } = await getDrafts();
  return loadDraft(userId, PENDING_SHARE_ID_DRAFT_KEY, isStringDraft);
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
 * Read-and-delete of the staged entry. Never deletes cache files here — the
 * composer's uploads still read those uris after take. Consuming the payload
 * also clears the durable pending-share-id hint so the gate never re-opens.
 * Returns the entry rather than its payload: a delivery that fails returns the
 * payload with `restoreSharePayload`, and that restore needs the stamp the
 * entry carried, because the signed-in account can change while the upload is
 * in flight.
 */
export function takeSharePayload(id: ShareId): StagedSharePayload | null {
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
  return entry;
}

/**
 * Put a payload back under the id it was taken with, after a delivery that
 * threw. The route keeps its `shareId`, so the next mount of that route (the
 * composer's own Retry) delivers the same files again instead of showing an
 * empty composer. Re-insertion re-files the id at the newest position and
 * evicts the oldest past the cap, so a restored payload lives exactly as long
 * as a freshly staged one.
 *
 * `stagedUserId` is the account that staged the entry when it was taken. The
 * entry returns to the store only while that account is still the signed-in
 * one, so a staged share stays inside its own account session. A null stamp is
 * a share captured while signed out: memory-only by design, and still restores.
 */
export function restoreSharePayload(
  id: ShareId,
  payload: SharePayload,
  stagedUserId: string | null
): void {
  if (stagedUserId !== null && stagedUserId !== sharePersistUserId) {
    // Nothing delivers this payload now, so its cache copies go with it.
    discardPayloadCacheFiles(payload);
    return;
  }
  if (payloads.has(id)) {
    return;
  }
  payloads.set(id, { payload, stagedUserId });
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
 * Reconciles one payload's attachment copies against the filesystem: a file
 * whose uri no longer exists moves its name into `failedFiles` and leaves
 * `files`, and a file that is still there keeps its place. The text is
 * untouched, so a payload whose copies all vanished still resumes as its text
 * plus the names it could not reach.
 */
function reconcilePayloadFiles(payload: SharePayload): SharePayload {
  const kept: AgentAttachmentCandidate[] = [];
  const failed = [...payload.failedFiles];
  for (const file of payload.files) {
    if (checkFileExists(file.uri)) {
      kept.push(file);
    } else {
      failed.push(file.name);
    }
  }
  return { text: payload.text, files: kept, failedFiles: failed };
}

/**
 * Restores the payloads map from the durable draft for `userId`. Merges the
 * draft in beside whatever the store already holds: an entry this process
 * staged for `userId` wins over the draft, and a capture staged before an
 * account resolved (null stamp) keeps its memory-only place while the account's
 * own draft resumes next to it, so the next snapshot can never erase the
 * account's retained draft. Each restored entry's files are reconciled against
 * the filesystem: a missing cache copy moves its name into `failedFiles` and
 * is dropped from `files`. A restored id that is already staged is left alone.
 *
 * `pendingShareId` is the durable pending-share hint the cold-start restore
 * reads to re-open the gate, and it is the only thing that restore reads after
 * this fill. The hint is therefore selected first: when it is retained at all,
 * the selection keeps it, and only the room that is left goes to the newest
 * other entries. Without that rule a newer retained entry (a composer handoff
 * staged after the share) takes the last slot the hint needs, and the account's
 * staged share is lost with no gate to show it again.
 */
export async function restoreSharePayloads(
  userId: string,
  pendingShareId: ShareId | null = null
): Promise<void> {
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

  // Fill only when this account owns no in-memory entry. The check runs after
  // the read settles so a put that lands during the read also wins, and it must
  // not be replaced with an early "no draft" return: a take/clear persists a
  // truthy empty draft (`{ order: [], entries: {} }`) that must not wipe live
  // in-memory shares.
  if ([...payloads.values()].some(entry => entry.stagedUserId === userId)) {
    return;
  }
  if (!draft) {
    return;
  }

  // Merge in recorded order, never clearing an entry staged by another owner.
  // The store is one bounded FIFO, so the restore fills only the room that is
  // left instead of evicting: what this process already staged stays readable
  // to the delivery that is about to consume it. The hint is selected first so
  // a retained hint always fits when any room exists; the newest other retained
  // entries then take the rest, which is the drop-oldest order of the store.
  const free = SHARE_PAYLOAD_MAX_ENTRIES - payloads.size;
  const retained = draft.order.filter(id => draft.entries[id] !== undefined && !payloads.has(id));
  // `slice(-0)` is `slice(0)`, so no room must select nothing explicitly.
  const room = Math.max(free, 0);
  const selected = new Set<ShareId>();
  if (room > 0 && pendingShareId !== null && retained.includes(pendingShareId)) {
    selected.add(pendingShareId);
  }
  const spare = room - selected.size;
  const others = retained.filter(id => !selected.has(id));
  for (const id of spare > 0 ? others.slice(-spare) : []) {
    selected.add(id);
  }
  for (const id of retained) {
    const entry = draft.entries[id];
    if (selected.has(id) && entry !== undefined) {
      // Each restored entry's files are reconciled against the filesystem on
      // the way in, so a missing cache copy reports as a failed name instead
      // of resuming as a file nobody can open.
      const payload = reconcilePayloadFiles({
        text: entry.text,
        files: entry.files.map(file => ({ name: file.name, uri: file.uri })),
        failedFiles: [...entry.failedFiles],
      });
      payloads.set(id, { payload, stagedUserId: userId });
      insertionOrder.push(id);
    }
  }
}

/**
 * Drop every payload staged under a signed-in account, with its cache copies.
 * The account boundary (sign-out and a direct account switch) calls this, so
 * staged share state belongs to exactly one account session: entries stamped
 * with that account leave with it.
 *
 * A payload staged while signed out keeps its place (DEC-01 account scope): it
 * is memory-only, and a same-process sign-in still opens the gate for it.
 * An account's own draft keeps the staged share for that account's next
 * sign-in, trimmed to the attachment copies that still exist: the boundary
 * reconciles every entry in that account's retained draft against the
 * filesystem, so the next sign-in resumes the text and reports the copies it
 * can no longer reach instead of resuming files that are already gone. The
 * trim is fire-and-forget — this call stays synchronous — and the draft write
 * is fenced to the account whose draft it describes.
 *
 * Subscribers receive the ids dropped here, in insertion order, so a subscriber
 * holding one pending id can tell whether its slot still names a staged entry.
 */
export function clearAccountStagedSharePayloads(): void {
  const dropped = [...payloads].filter(([, entry]) => entry.stagedUserId !== null);
  const droppedIds: ShareId[] = [];
  for (const [id, entry] of dropped) {
    payloads.delete(id);
    const index = insertionOrder.indexOf(id);
    if (index !== -1) {
      insertionOrder.splice(index, 1);
    }
    discardPayloadCacheFiles(entry.payload);
    droppedIds.push(id);
  }
  if (dropped.length === 0) {
    return;
  }
  // The pending slot lives in the root layout and resets with the payloads, so
  // the shell and the store always describe the same staged share.
  for (const listener of accountStagedClearListeners) {
    listener(droppedIds);
  }
  // Then trim each departing account's retained draft. `reapTempFiles({ all:
  // true })` in `clearSessionScopedState` deletes every share copy before this
  // boundary runs, so a draft left naming those uris could only ever reopen
  // text at that account's next sign-in: reconciliing it now is what lets the
  // resume deliver the copies that survive and report the rest. The whole
  // draft is reconciled, not just the dropped ids, because the boundary
  // removes the account's copies whatever entry named them.
  //
  // The boundary stays synchronous, and the inner handler owns the rejection
  // so it can never surface as an unhandled rejection or reach the caller.
  void (async () => {
    try {
      const { loadDraft, saveDraft, flushDraft, SHARE_PAYLOADS_DRAFT_KEY, isSharePayloadsDraft } =
        await getDrafts();
      const departing = new Set<string>();
      for (const [, entry] of dropped) {
        if (entry.stagedUserId !== null) {
          departing.add(entry.stagedUserId);
        }
      }
      await Promise.all(
        [...departing].map(async userId => {
          const draft = await loadDraft(userId, SHARE_PAYLOADS_DRAFT_KEY, isSharePayloadsDraft);
          // The persist scope can move while the draft read is in flight, and
          // a rewrite belongs to the account whose copies it describes: a
          // draft read for an account that is no longer the persist scope is
          // left exactly as it was.
          if (getSharePersistUserId() !== userId || draft === null) {
            return;
          }
          // Every entry stays in the draft: only file uris leave (as failed
          // names), so an entry whose copies all vanished still resumes its
          // text. `order` is untouched.
          const entries = Object.fromEntries(
            Object.entries(draft.entries).map(([id, entry]) => [id, reconcilePayloadFiles(entry)])
          );
          saveDraft(userId, SHARE_PAYLOADS_DRAFT_KEY, { order: draft.order, entries });
          await flushDraft(userId, SHARE_PAYLOADS_DRAFT_KEY);
        })
      );
    } catch (error) {
      captureTelemetry({
        error,
        level: 'warning',
        tags: { 'error.subsystem': 'share', 'error.operation': 'rewrite_retained_draft' },
      });
    }
  })();
}

/**
 * Subscribe to the account boundary dropping staged payloads. The root layout
 * uses it to reset its pending share id; it fires only when a stamped entry
 * was dropped, and it passes the dropped ids so the subscriber resets its slot
 * only when that slot names one of them: a capture staged before an account
 * resolves keeps its slot.
 */
export function subscribeAccountStagedShareClear(
  listener: (droppedIds: readonly ShareId[]) => void
): () => void {
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

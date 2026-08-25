import * as Crypto from 'expo-crypto';
import { cacheDirectory, copyAsync, deleteAsync, getInfoAsync } from 'expo-file-system/legacy';
import { type ShareIntent } from 'expo-share-intent';

import { type AgentAttachmentCandidate } from '@/lib/agent-attachments/use-agent-attachment-upload';
import type * as DraftsModule from '@/lib/persist/drafts';

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

/** Mirrors PROMPT_INPUT_MAX_CHARS in new-session-prompt.tsx (module-local; composer clamps again). */
export const SHARE_TEXT_MAX_CHARS = 4000;

export const SHARE_PAYLOAD_MAX_ENTRIES = 5;

type ShareIntentLike = Pick<ShareIntent, 'text' | 'webUrl' | 'meta' | 'files'>;

type CopyToCache = (args: { from: string; fileName: string }) => Promise<string>;

type DeleteCachedFile = (uri: string) => Promise<void>;

const payloads = new Map<ShareId, SharePayload>();
const insertionOrder: ShareId[] = [];

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

async function defaultDeleteCachedFile(uri: string): Promise<void> {
  try {
    await deleteAsync(uri, { idempotent: true });
  } catch {
    // Best-effort hygiene; ignore delete failures.
  }
}

let deleteCachedFile: DeleteCachedFile = defaultDeleteCachedFile;

type FileExists = (uri: string) => Promise<boolean>;

async function defaultFileExists(uri: string): Promise<boolean> {
  try {
    const info = await getInfoAsync(uri);
    return info.exists && !info.isDirectory;
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
  for (const [id, payload] of payloads) {
    entries[id] = {
      text: payload.text,
      files: payload.files.map(file => ({ name: file.name, uri: file.uri })),
      failedFiles: [...payload.failedFiles],
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
 */
async function clearPendingShareIdDraft(id: ShareId): Promise<void> {
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
        discardPayloadCacheFiles(evicted);
      }
    }
  }
  void persistSharePayloadsNow();
}

/** Adds an entry and returns its id. Evicts oldest beyond SHARE_PAYLOAD_MAX_ENTRIES. */
export function putSharePayload(payload: SharePayload): ShareId {
  const id = Crypto.randomUUID();
  payloads.set(id, payload);
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
  const payload = payloads.get(id) ?? null;
  if (payload === null) {
    return null;
  }
  payloads.delete(id);
  const index = insertionOrder.indexOf(id);
  if (index !== -1) {
    insertionOrder.splice(index, 1);
  }
  void persistSharePayloadsNow();
  void clearPendingShareIdDraft(id);
  return payload;
}

/** Read-only, for the gate's own preview. */
export function peekSharePayload(id: ShareId): SharePayload | null {
  return payloads.get(id) ?? null;
}

/** Id-scoped abandonment. Never clears another id's entry. */
export function clearSharePayload(id: ShareId): void {
  const payload = payloads.get(id);
  if (payload === undefined) {
    return;
  }
  payloads.delete(id);
  const index = insertionOrder.indexOf(id);
  if (index !== -1) {
    insertionOrder.splice(index, 1);
  }
  discardPayloadCacheFiles(payload);
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
        text: entry.text,
        files: entry.files.map(file => ({ name: file.name, uri: file.uri })),
        failedFiles: [...entry.failedFiles],
      });
      insertionOrder.push(id);
    }
  }

  // Then reconcile each file against the filesystem.
  await Promise.all(
    [...payloads.values()].map(async payload => {
      const kept: AgentAttachmentCandidate[] = [];
      const failed = [...payload.failedFiles];
      const checks = await Promise.all(
        payload.files.map(async file => {
          const exists = await checkFileExists(file.uri);
          return { file, exists };
        })
      );
      for (const { file, exists } of checks) {
        if (exists) {
          kept.push(file);
        } else {
          failed.push(file.name);
        }
      }
      payload.files.length = 0;
      payload.files.push(...kept);
      payload.failedFiles.length = 0;
      payload.failedFiles.push(...failed);
    })
  );
}

/** Test-only: wipe the module store between cases. */
export function __resetSharePayloadStoreForTests(): void {
  payloads.clear();
  insertionOrder.length = 0;
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
  const root = cacheDirectory;
  if (!root) {
    throw new Error('cacheDirectory is unavailable');
  }
  const safeName = args.fileName.replaceAll(/[/\\]/g, '_') || 'shared-file';
  const destination = `${root}share-${Crypto.randomUUID()}-${safeName}`;
  await copyAsync({ from: args.from, to: destination });
  return destination;
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

  // Throw only when nothing usable remains: no text and zero successful copies
  // while at least one file was attempted.
  if (text === '' && files.length === 0 && incomingFiles.length > 0) {
    throw new Error('Failed to copy shared files');
  }

  return { text, files, failedFiles };
}

import * as Sentry from '@sentry/react-native';
import {
  captureAccountGeneration,
  getAuthenticatedOwner,
  isAuthenticatedOwner,
} from '@/lib/context-scope';
import { chainSave } from '@/lib/hooks/save-chain';
import { parseStoredDraft, serializeStoredDraft } from '@/lib/storage-keys';
import * as encryptedKv from '@/lib/persist/encrypted-kv';

/** Durable drafts retain their JSON values and draft:<userId> scopes across sign-out. */
export const DRAFT_DEBOUNCE_MS = 500;
export const DRAFT_MAX_BYTES = 64 * 1024;
export const DRAFT_MAX_ENTRIES = 100;
export const SCOPED_DRAFT_KEY_PREFIX = 'context-draft:v1:';
export function draftScope(userId: string): string {
  return `draft:${userId}`;
}

// Compatibility path: unchanged callers retain these exports and nullable reads. New consumers use
// scoped-draft-keys/useScopedDraftLoad. Remove legacy forms only after a6 and explicit recovery finish.
export {
  agentComposerDraftKey,
  isStringDraft,
  isMergeDraft,
  isSharePayloadsDraft,
  isShareNavigationDraft,
  NEW_SESSION_DRAFT_KEY,
  SHARE_PAYLOADS_DRAFT_KEY,
  SHARE_NAV_DRAFT_KEY,
  PENDING_SHARE_ID_DRAFT_KEY,
  SESSION_SEARCH_DRAFT_KEY,
  prReviewDraftKey,
  prMergeDraftKey,
  prReplyDraftKey,
  prCommentDraftKey,
  securityDismissDraftKey,
  resolvePrefillOverDraft,
  type SharePayloadsDraft,
  type ShareNavigationDraft,
} from '@/lib/storage-keys';
export type DraftShapeValidator<T> = (value: unknown) => value is T;
export type DraftLoadResult<T> =
  | ReturnType<typeof parseStoredDraft<T>>
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'failed'; error: unknown }>;
export type DraftWriteResult = 'committed' | 'failed' | 'stale' | 'conflict';
export type DraftWriteOptions = { isCurrent?: () => boolean; expectedSerialized?: string | null };
type DraftWritePayload = DraftWriteOptions & {
  generationFence: () => boolean;
  userId: string;
  entityKey: string;
  serialized: string;
};
type PendingSave = DraftWritePayload & { timer: ReturnType<typeof setTimeout> };
const pendingSaves = new Map<string, PendingSave>();
function fullKey(userId: string, entityKey: string): string {
  return JSON.stringify([draftScope(userId), entityKey]);
}
function takePending(key: string): PendingSave | undefined {
  const pending = pendingSaves.get(key);
  clearTimeout(pending?.timer);
  pendingSaves.delete(key);
  return pending;
}
function reportDraftFailure(
  error: unknown,
  operation: 'read' | 'write' | 'clear',
  fingerprint?: string
): void {
  Sentry.captureException(error, {
    level: 'warning',
    tags: { 'error.subsystem': 'drafts', 'error.operation': operation },
    ...(fingerprint ? { fingerprint: [fingerprint] } : {}),
  });
}
function canWrite(userId: string, entityKey: string, isCurrent?: () => boolean): boolean {
  const owner = getAuthenticatedOwner();
  return (
    Boolean(userId) &&
    (!isCurrent || isCurrent()) &&
    (!entityKey.startsWith(SCOPED_DRAFT_KEY_PREFIX) ||
      (Boolean(isCurrent) && isAuthenticatedOwner(owner) && owner.userId === userId))
  );
}

/** A rejected read never proves absence. New tagged reads also require authoritative owner proof. */
// eslint-disable-next-line max-params -- the optional fence preserves the legacy read API
export async function loadDraftResult<T>(
  userId: string,
  entityKey: string,
  isValid: DraftShapeValidator<T>,
  isCurrent?: () => boolean
): Promise<DraftLoadResult<T>> {
  const generationFence = captureAccountGeneration();
  const owner = getAuthenticatedOwner();
  const allowed = () =>
    Boolean(userId) &&
    generationFence() &&
    (!isCurrent || isCurrent()) &&
    (!entityKey.startsWith(SCOPED_DRAFT_KEY_PREFIX) ||
      (isAuthenticatedOwner(owner) && owner.userId === userId));
  if (!allowed()) {
    return { status: 'failed', error: new Error('Draft owner is unresolved') };
  }
  let raw: string | null = null;
  try {
    raw = await encryptedKv.getItem(draftScope(userId), entityKey);
  } catch (error) {
    reportDraftFailure(error, 'read');
    return { status: 'failed', error };
  }
  if (!allowed()) {
    return { status: 'failed', error: new Error('Draft owner changed') };
  }
  if (raw === null) {
    return { status: 'absent' };
  }
  const parsed = parseStoredDraft(raw, isValid, DRAFT_MAX_BYTES);
  if (parsed.status === 'malformed') {
    const fingerprints = {
      size: 'draft-read-size-limit',
      shape: 'draft-read-shape-mismatch',
      json: undefined,
    };
    reportDraftFailure(new Error('Malformed draft'), 'read', fingerprints[parsed.reason]);
  }
  return parsed;
}
export async function loadDraft<T>(
  userId: string,
  entityKey: string,
  isValid: DraftShapeValidator<T>
): Promise<T | null> {
  const result = await loadDraftResult(userId, entityKey, isValid);
  return result.status === 'present' ? result.value : null;
}
function serializeDraft(value: unknown): string | null {
  return serializeStoredDraft(value, DRAFT_MAX_BYTES, (failure, fingerprint) => {
    reportDraftFailure(failure, 'write', fingerprint);
  });
}
async function evictOldestBeyondCap(
  payload: DraftWritePayload,
  isCurrent: () => boolean
): Promise<void> {
  const scope = draftScope(payload.userId);
  const all = await encryptedKv.listEntries(scope);
  // New writes preserve ambiguous legacy candidates. Only explicit migration can remove them.
  const entries = payload.entityKey.startsWith(SCOPED_DRAFT_KEY_PREFIX)
    ? all.filter(entry => entry.k.startsWith(SCOPED_DRAFT_KEY_PREFIX))
    : all;
  await Promise.all(
    entries.slice(0, Math.max(0, entries.length - DRAFT_MAX_ENTRIES)).map(async entry => {
      await encryptedKv.removeItem(scope, entry.k, isCurrent);
    })
  );
}
async function writeDraftSafely(payload: DraftWritePayload): Promise<DraftWriteResult> {
  const { userId, entityKey, serialized, expectedSerialized } = payload;
  const isCurrent = () =>
    payload.generationFence() && canWrite(userId, entityKey, payload.isCurrent);
  try {
    return await chainSave<DraftWriteResult>(fullKey(userId, entityKey), async () => {
      if (!isCurrent()) {
        return 'stale';
      }
      if (expectedSerialized !== undefined) {
        const current = await encryptedKv.getItem(draftScope(userId), entityKey);
        if (!isCurrent()) {
          return 'stale';
        }
        if (current !== expectedSerialized || pendingSaves.has(fullKey(userId, entityKey))) {
          return 'conflict';
        }
      }
      await encryptedKv.setItem(draftScope(userId), entityKey, serialized, isCurrent);
      if (!isCurrent()) {
        return 'stale';
      }
      await evictOldestBeyondCap(payload, isCurrent);
      return isCurrent() ? 'committed' : 'stale';
    });
  } catch (error) {
    reportDraftFailure(error, 'write');
    return 'failed';
  }
}
/** Immediate confirmed persistence. Migration cannot infer a commit from saveDraft or flushDraft. */
// eslint-disable-next-line max-params -- retain user/key/value positions from saveDraft
export async function saveDraftConfirmed(
  userId: string,
  entityKey: string,
  value: unknown,
  options: DraftWriteOptions = {}
): Promise<DraftWriteResult> {
  if (!canWrite(userId, entityKey, options.isCurrent)) {
    return 'stale';
  }
  const serialized = serializeDraft(value);
  if (serialized === null) {
    return 'failed';
  }
  const result = await writeDraftSafely({
    ...options,
    generationFence: captureAccountGeneration(),
    userId,
    entityKey,
    serialized,
  });
  return result;
}
// eslint-disable-next-line max-params -- scoped callers add their restored hook's fence without changing legacy producers
export function saveDraft(
  userId: string,
  entityKey: string,
  value: unknown,
  isCurrent?: () => boolean
): void {
  if (!canWrite(userId, entityKey, isCurrent)) {
    return;
  }
  const serialized = serializeDraft(value);
  if (serialized === null) {
    return;
  }
  const key = fullKey(userId, entityKey);
  takePending(key);
  const payload = {
    generationFence: captureAccountGeneration(),
    userId,
    entityKey,
    serialized,
    isCurrent,
  };
  const timer = setTimeout(() => {
    pendingSaves.delete(key);
    void writeDraftSafely(payload);
  }, DRAFT_DEBOUNCE_MS);
  pendingSaves.set(key, { ...payload, timer });
}
export async function flushDraft(
  userId: string,
  entityKey: string,
  isCurrent?: () => boolean
): Promise<void> {
  if (!canWrite(userId, entityKey, isCurrent)) {
    return;
  }
  const key = fullKey(userId, entityKey);
  const pending = takePending(key);
  if (pending) {
    await writeDraftSafely(pending);
  }
}
export async function clearDraft(
  userId: string,
  entityKey: string,
  isCurrent?: () => boolean
): Promise<boolean> {
  if (!userId) {
    return true;
  }
  if (!canWrite(userId, entityKey, isCurrent)) {
    return false;
  }
  const key = fullKey(userId, entityKey);
  takePending(key);
  const generationFence = captureAccountGeneration();
  const allowed = () => generationFence() && canWrite(userId, entityKey, isCurrent);
  try {
    return await chainSave(key, async () => {
      if (!allowed()) {
        return false;
      }
      await encryptedKv.removeItem(draftScope(userId), entityKey, allowed);
      return allowed();
    });
  } catch (error) {
    reportDraftFailure(error, 'clear');
    return false;
  }
}
/** Compare settled source bytes before cleanup. A newer edit, owner, or generation wins. */
// eslint-disable-next-line max-params -- the optional migration fence preserves pending-share callers
export async function clearDraftIfStill(
  userId: string,
  entityKey: string,
  expectedSerialized: string,
  isCurrent?: () => boolean
): Promise<void> {
  const generationFence = captureAccountGeneration();
  const allowed = () => generationFence() && canWrite(userId, entityKey, isCurrent);
  const key = fullKey(userId, entityKey);
  try {
    await chainSave(key, async () => {
      if (!allowed()) {
        return;
      }
      const current = await encryptedKv.getItem(draftScope(userId), entityKey);
      if (allowed() && current === expectedSerialized && !pendingSaves.has(key)) {
        await encryptedKv.removeItem(draftScope(userId), entityKey, allowed);
      }
    });
  } catch (error) {
    reportDraftFailure(error, 'clear');
  }
}
export function resetDraftTimersForTests(): void {
  for (const key of pendingSaves.keys()) {
    takePending(key);
  }
}

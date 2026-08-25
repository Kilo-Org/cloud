import * as Sentry from '@sentry/react-native';
import * as z from 'zod';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { chainSave } from '@/lib/hooks/save-chain';
import { utf8ByteLength } from '@/lib/utf8-utils';
import * as encryptedKv from '@/lib/persist/encrypted-kv';

/**
 * Durable high-intent drafts over the encrypted SQLCipher KV store (DEC-01).
 *
 * One entry per `entityKey` under scope `draft:<userId>`, so a draft is
 * account-scoped and survives sign-out by design (user work is not
 * refetchable; cache rows are deleted on sign-out, drafts are not).
 *
 * Writes are debounced 500 ms per full storage key (`draft:<userId>` +
 * entityKey): every pending timer closes over its own userId, entityKey, and
 * value, so switching entity keys or accounts in the same epoch never
 * retargets an older timer — the old key receives only its own write. Each
 * write is epoch-fenced and serialized per full key via `chainSave`; values
 * over 64 KB are skipped (never written partially); a scope holds at most
 * 100 entries, evicting the oldest `updated_at` above the cap.
 *
 * A corrupt or unreadable stored value loads as null (start empty) and is
 * reported to Sentry with no toast: there is no user action that re-reads a
 * draft, so the failure is structurally non-retryable and the composer is
 * already usable empty. Callers pass a shape validator, so a valid-JSON value
 * that does not match its contract (e.g. a number where composer text is
 * expected) is treated as corrupt and discarded the same way.
 *
 * Every asynchronous write (debounced timer, flush, clear) is caught at this
 * boundary: a storage failure is reported to Sentry and swallowed, so the
 * fire-and-forget `void` call sites can never leak an unhandled rejection.
 *
 * Serialization is contained before any timer exists: a value that cannot be
 * JSON-serialized (a circular reference, or a top-level undefined) is
 * reported to Sentry and skipped without scheduling a write.
 */

export const DRAFT_DEBOUNCE_MS = 500;
export const DRAFT_MAX_BYTES = 64 * 1024;
export const DRAFT_MAX_ENTRIES = 100;

const DRAFT_SCOPE_PREFIX = 'draft:';

/** One user's draft scope. Entity keys live as KV items under this scope. */
export function draftScope(userId: string): string {
  return `${DRAFT_SCOPE_PREFIX}${userId}`;
}

const stringDraftSchema = z.string();

/** Runtime shape guard for a composer text draft (a JSON string). */
export function isStringDraft(value: unknown): value is string {
  return stringDraftSchema.safeParse(value).success;
}

/** Shape validator for one loaded draft value, supplied by the caller. */
export type DraftShapeValidator<T> = (value: unknown) => value is T;

/** Session composer draft entity key. */
export function agentComposerDraftKey(sessionId: string): string {
  return `agent-composer:${sessionId}`;
}

/** New-session prompt draft entity key. */
export const NEW_SESSION_DRAFT_KEY = 'agent-composer:new';

/** Pending-review draft entity key, unique per pull request. */
export function prReviewDraftKey(owner: string, repo: string, number: number): string {
  return `pr-review:${owner}/${repo}#${number}`;
}

/** Merge-sheet draft entity key, unique per pull request. */
export function prMergeDraftKey(owner: string, repo: string, number: number): string {
  return `pr-merge:${owner}/${repo}#${number}`;
}

/** Reply draft entity key, unique per review comment thread. */
// eslint-disable-next-line eslint/max-params -- the key encodes owner, repo, number, and comment id
export function prReplyDraftKey(
  owner: string,
  repo: string,
  number: number,
  commentId: number
): string {
  return `pr-reply:${owner}/${repo}#${number}:${commentId}`;
}

/** Inline review-comment draft entity key, unique per diff position. */
// eslint-disable-next-line eslint/max-params -- the key encodes the full diff position
export function prCommentDraftKey(
  owner: string,
  repo: string,
  number: number,
  path: string,
  side: string,
  line: number,
  startLine?: number
): string {
  return `pr-comment:${owner}/${repo}#${number}:${path}:${side}:${startLine ?? line}-${line}`;
}

const mergeDraftSchema = z.object({
  title: z.string(),
  message: z.string(),
});

/** Runtime shape guard for a merge-sheet draft ({ title, message }). */
export function isMergeDraft(value: unknown): value is { title: string; message: string } {
  return mergeDraftSchema.safeParse(value).success;
}

/** Security dismiss draft entity key, unique per scope and finding. */
export function securityDismissDraftKey(scope: string, findingId: string): string {
  return `security-dismiss:${scope}:${findingId}`;
}

/**
 * New-session initial-prompt precedence: a non-empty share prefill always
 * beats a stored draft (the share payload is the user's explicit current
 * intent); an empty or absent prefill falls back to the stored draft. The
 * caller resolves both before mounting the input, so a draft never renders
 * first and gets replaced by a late prefill.
 */
export function resolvePrefillOverDraft(
  prefillText: string | null | undefined,
  draftText: string | null | undefined
): string | undefined {
  if (prefillText !== undefined && prefillText !== null && prefillText.trim().length > 0) {
    return prefillText;
  }
  return draftText ?? undefined;
}

/** The epoch-fenced write payload for one draft write. */
type DraftWritePayload = {
  epoch: number;
  userId: string;
  entityKey: string;
  serialized: string;
};

type PendingSave = {
  timer: ReturnType<typeof setTimeout>;
  epoch: number;
  serialized: string;
};

// One pending debounced write per full storage key. The timer, epoch, and
// value are captured together under the full key, so a later save for a
// different key (or a different account with the same entity key) can never
// retarget it.
const pendingSaves = new Map<string, PendingSave>();

function fullKey(userId: string, entityKey: string): string {
  return `${draftScope(userId)}\u0000${entityKey}`;
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

/**
 * Loads one draft. Returns the parsed JSON value, or null when the key is
 * absent, the value is corrupt/unreadable, the value exceeds the 64 KB cap,
 * or the parsed value fails the caller's shape validator — all but the absent
 * case load as empty and report corruption to Sentry. The value shape is the
 * caller's contract: composer text stores a JSON string, and pending-review
 * stores a JSON `PendingReviewItem[]`.
 */
export async function loadDraft<T>(
  userId: string,
  entityKey: string,
  isValid: DraftShapeValidator<T>
): Promise<T | null> {
  if (!userId) {
    return null;
  }
  try {
    const raw = await encryptedKv.getItem(draftScope(userId), entityKey);
    if (raw === null) {
      return null;
    }
    if (utf8ByteLength(raw) > DRAFT_MAX_BYTES) {
      reportDraftFailure(
        new Error('stored draft exceeds the 64 KB cap'),
        'read',
        'draft-read-size-limit'
      );
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isValid(parsed)) {
      reportDraftFailure(
        new Error('stored draft does not match its expected shape'),
        'read',
        'draft-read-shape-mismatch'
      );
      return null;
    }
    return parsed;
  } catch (error) {
    reportDraftFailure(error, 'read');
    return null;
  }
}

async function writeDraft({
  epoch,
  userId,
  entityKey,
  serialized,
}: DraftWritePayload): Promise<void> {
  const key = fullKey(userId, entityKey);
  await chainSave(key, async () => {
    // The authoritative fence lives inside the chained run: a write queued
    // before a sign-out/sign-in must never land after the epoch moved.
    if (!isCurrentAuthEpoch(epoch)) {
      return;
    }
    await encryptedKv.setItem(draftScope(userId), entityKey, serialized);
    await evictOldestBeyondCap(draftScope(userId));
  });
}

/**
 * Runs a draft write and contains every failure at this boundary: the error
 * is reported to Sentry and swallowed, so the debounced timer and the
 * fire-and-forget flush/clear call sites can never leak an unhandled
 * rejection, and the composer stays usable (the previous stored value, if
 * any, is left untouched).
 */
async function writeDraftSafely(payload: DraftWritePayload): Promise<void> {
  try {
    await writeDraft(payload);
  } catch (error) {
    reportDraftFailure(error, 'write');
  }
}

async function evictOldestBeyondCap(scope: string): Promise<void> {
  const entries = await encryptedKv.listEntries(scope);
  if (entries.length <= DRAFT_MAX_ENTRIES) {
    return;
  }
  // `listEntries` is oldest-first; remove the oldest entries down to the cap.
  const overflow = entries.length - DRAFT_MAX_ENTRIES;
  const oldest = entries.slice(0, overflow);
  await Promise.all(
    oldest.map(async entry => {
      await encryptedKv.removeItem(scope, entry.k);
    })
  );
}

/**
 * Schedules a debounced save of one JSON-serializable draft value, keyed on
 * the full storage key. Values over 64 KB are skipped (never written
 * partially; a previously stored draft stays untouched). Unserializable
 * values (circular references, top-level undefined) are reported to Sentry
 * and skipped. Returns nothing — the write is fire-and-forget; use
 * {@link flushDraft} to force it.
 */
export function saveDraft(userId: string, entityKey: string, value: unknown): void {
  if (!userId) {
    return;
  }
  try {
    // JSON.stringify produces no string for a top-level undefined, function,
    // or symbol; reject those before the byte-cap check, which needs a string.
    const serialized = JSON.stringify(value) as string | undefined;
    if (serialized === undefined) {
      reportDraftFailure(
        new Error('draft value cannot be serialized to JSON'),
        'write',
        'draft-write-unsupported-value'
      );
      return;
    }
    if (utf8ByteLength(serialized) > DRAFT_MAX_BYTES) {
      return;
    }
    const key = fullKey(userId, entityKey);
    const previous = pendingSaves.get(key);
    if (previous) {
      clearTimeout(previous.timer);
    }
    const epoch = currentAuthEpoch();
    const timer = setTimeout(() => {
      pendingSaves.delete(key);
      void writeDraftSafely({ epoch, userId, entityKey, serialized });
    }, DRAFT_DEBOUNCE_MS);
    pendingSaves.set(key, { timer, epoch, serialized });
  } catch (error) {
    // Serialization and byte sizing run before any timer exists; contain
    // every failure here so saveDraft never throws synchronously.
    reportDraftFailure(error, 'write');
  }
}

/**
 * Forces the pending debounced write for the full key to run now (AppState
 * background, unmount, and tests). A no-op when no write is pending. Write
 * failures are reported to Sentry and swallowed, so callers can invoke it
 * fire-and-forget.
 */
export async function flushDraft(userId: string, entityKey: string): Promise<void> {
  if (!userId) {
    return;
  }
  const key = fullKey(userId, entityKey);
  const pending = pendingSaves.get(key);
  if (!pending) {
    return;
  }
  clearTimeout(pending.timer);
  pendingSaves.delete(key);
  await writeDraftSafely({ ...pending, userId, entityKey });
}

/**
 * Cancels the key's pending debounced write and removes the stored entry.
 * Serialized behind any in-flight write for the same key, so a clear can
 * never race a queued save back into existence. Not epoch-fenced: clearing
 * is explicit user intent and must work regardless of auth transitions.
 * Remove failures are reported to Sentry and swallowed, but the returned
 * boolean tells the caller whether the entry was actually removed, so a
 * discard flow can stay on the screen when the clear fails.
 */
export async function clearDraft(userId: string, entityKey: string): Promise<boolean> {
  if (!userId) {
    return true;
  }
  const key = fullKey(userId, entityKey);
  const pending = pendingSaves.get(key);
  if (pending) {
    clearTimeout(pending.timer);
    pendingSaves.delete(key);
  }
  try {
    await chainSave(key, async () => {
      await encryptedKv.removeItem(draftScope(userId), entityKey);
    });
    return true;
  } catch (error) {
    reportDraftFailure(error, 'clear');
    return false;
  }
}

// Test-only: cancels every pending debounced timer so a test never leaks a
// fire into a later case (the same pattern as `resetEncryptedKvOpenForTests`).
export function resetDraftTimersForTests(): void {
  for (const pending of pendingSaves.values()) {
    clearTimeout(pending.timer);
  }
  pendingSaves.clear();
}

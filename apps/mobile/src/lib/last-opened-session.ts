import { z } from 'zod';

import { readStoredValueWithRetry } from '@/lib/auth/secure-store-read';
import {
  deleteStoredValueSafe,
  readStoredValue,
  writeStoredValueSafe,
} from '@/lib/auth/secure-store-value';
import {
  isProtectedDataAvailable,
  ProtectedDataUnavailableError,
  subscribeToProtectedDataAvailable,
} from '@/lib/protected-data';
import { LAST_OPENED_SESSION_KEY } from '@/lib/storage-keys';

/**
 * The durable "Open last session" record behind the launcher shortcut and the
 * quick-settings tile. The in-memory record is the source of truth for the
 * current JS run and SecureStore is only a mirror so the choice survives a
 * restart. `userId` scopes the record to its account, so one account is never
 * offered another account's session; a record for a different account reads as
 * null and needs no sign-out wiring.
 *
 * The mirror is read and written through `lib/auth/secure-store*`, the one
 * guarded keychain entry point. The first read spends that module's bounded
 * retry budget, so a transient refusal is retried and a real failure files one
 * report; this file never duplicates either.
 */

export type LastOpenedSessionRecord = {
  sessionId: string;
  userId: string;
  storedAt: number;
};

const lastOpenedSessionSchema = z.object({
  sessionId: z.string(),
  userId: z.string(),
  storedAt: z.number(),
});

let record: LastOpenedSessionRecord | null = null;
/**
 * Where the restart read stands. `answered` is the only settled state that
 * stays for the run: a read that answered — a record or no record — is the
 * answer, and asking the keychain again would return the same bytes. `failed`
 * means the read never answered, so a later reader tries again instead of
 * inheriting an absence the keychain never stated.
 */
type Hydration =
  | { readonly status: 'idle' }
  | { readonly status: 'pending'; readonly promise: Promise<void> }
  | { readonly status: 'answered' }
  | {
      readonly status: 'failed';
      /**
       * How the next attempt reads. The first read, and every read after a
       * locked refusal, spends the full retry budget in
       * `lib/auth/secure-store-read`, which reports a failure once. A later
       * attempt after a real refusal reads once and silently: the mirror is
       * best effort, this record is not a credential, and a reader on a broken
       * keychain runs on every render — a reported budget each time would turn
       * one failure into a stream of events.
       */
      readonly nextAttempt: 'budget' | 'single';
    };
let hydration: Hydration = { status: 'idle' };
/**
 * The re-read armed at the next unlock after a locked refusal. One per module:
 * a read that finds the keychain locked again must not stack a second
 * subscription, and an unlock that lands after the read gave up is still
 * observed.
 */
let unlockRetry: (() => void) | null = null;
// Monotonic epoch bumped on every in-memory write, so a record written while
// the restart read is pending can never be clobbered by the stale persisted
// record.
let epoch = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Parse a stored record; a corrupt or unreadable mirror reads as absent. */
function parseStoredRecord(raw: string): LastOpenedSessionRecord | null {
  try {
    const result = lastOpenedSessionSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** Best-effort SecureStore write; the in-memory record is the source of truth. */
async function mirrorRecord(serialized: string): Promise<void> {
  // An absent or older development client has no secure store, and a failed
  // mirror leaves the in-memory record authoritative. The helper reports a real
  // failure at warning level and skips the call while the device is locked.
  await writeStoredValueSafe(LAST_OPENED_SESSION_KEY, serialized);
}

/** Best-effort SecureStore delete; an absent store has nothing to delete. */
async function dropMirroredRecord(): Promise<void> {
  // A failed delete leaves the record to be discarded on the next write; the
  // helper reports it and skips the call while the device is locked.
  await deleteStoredValueSafe(LAST_OPENED_SESSION_KEY);
}

// The SecureStore mirror is serialized through this chain: each operation runs
// only after the one before it settled, so a sign-out delete cannot be overtaken
// by a write still in flight and two rapid writes cannot settle out of order.
// The operations swallow their own failures, so the chain never rejects; the
// in-memory record stays the source of truth. An idle chain still starts its
// operation synchronously, so a lone write mirrors immediately.
let mirrorTail: Promise<void> | null = null;

function chainMirror(operation: () => Promise<void>): void {
  mirrorTail = runAfterMirror(mirrorTail, operation);
}

async function runAfterMirror(
  previous: Promise<void> | null,
  operation: () => Promise<void>
): Promise<void> {
  if (previous !== null) {
    await previous;
  }
  await operation();
}

/**
 * Arm one re-read for the next unlock: while the device is locked every
 * keychain read is refused without reaching the store, so the answer becomes
 * readable at the unlock and the mount must not wait for an unrelated
 * re-render to ask again.
 */
function armUnlockRetry(): void {
  if (unlockRetry !== null) {
    return;
  }
  const release = subscribeToProtectedDataAvailable(() => {
    disarmUnlockRetry();
    if (hydration.status !== 'failed') {
      // A read answered, or a newer one owns the attempt: this unlock has
      // nothing left to re-read.
      return;
    }
    hydration = { status: 'idle' };
    void hydrate();
  });
  unlockRetry = () => {
    release();
    unlockRetry = null;
  };
}

function disarmUnlockRetry(): void {
  unlockRetry?.();
}

/**
 * Restore the in-memory record after a JS restart. The read is the guarded,
 * bounded-retry read, so a transient refusal is retried there and a spent
 * budget reports once. A write that lands during the read owns the state and
 * skips the stale persisted record.
 */
async function restore(nextAttempt: 'budget' | 'single'): Promise<void> {
  const startEpoch = epoch;
  try {
    // A single attempt is the later read after a real refusal: it stays silent
    // so a keychain that keeps refusing cannot file one event per render. A
    // locked device never reaches the store either way — the guard in
    // `readStoredValue` refuses before the call — so the lock costs no read and
    // files nothing, whatever kind of attempt it is.
    const raw =
      nextAttempt === 'budget'
        ? await readStoredValueWithRetry(LAST_OPENED_SESSION_KEY)
        : await readStoredValue(LAST_OPENED_SESSION_KEY);
    // The read answered: a record, or nothing stored. Either way this is the
    // answer for the run, so no reader asks the keychain again. It also covers
    // the case below where a write landed first and already owns the state.
    disarmUnlockRetry();
    hydration = { status: 'answered' };
    if (raw === null || epoch !== startEpoch || record !== null) {
      return;
    }
    const parsed = parseStoredRecord(raw);
    if (parsed !== null) {
      record = parsed;
      notify();
    }
  } catch (error) {
    // The read never answered, so this run must not serve its absence for the
    // rest of the process. The next reader tries again: with the full reported
    // budget while the device is locked, because an unlock can make the record
    // readable and nothing has been spent on the store yet; once and silently
    // after a real refusal, which was already reported. A reader that never
    // reached the store threw the guard's own error; one whose call the device
    // refused reports the lock in the protected-data state.
    if (!isProtectedDataAvailable() || error instanceof ProtectedDataUnavailableError) {
      hydration = { status: 'failed', nextAttempt: 'budget' };
      armUnlockRetry();
      return;
    }
    hydration = { status: 'failed', nextAttempt: 'single' };
  }
}

async function hydrate(): Promise<void> {
  const current = hydration;
  // An `answered` read is the run's answer, and an attempt already in flight is
  // shared by every reader that arrives meanwhile.
  if (current.status === 'answered') {
    return;
  }
  if (current.status === 'pending') {
    await current.promise;
    return;
  }
  const promise = restore(current.status === 'failed' ? current.nextAttempt : 'budget');
  hydration = { status: 'pending', promise };
  await promise;
}

/** Remember the session an account opened last. A null account records nothing. */
export function recordLastOpenedSession(sessionId: string, userId: string | null): void {
  if (userId === null) {
    return;
  }
  epoch += 1;
  record = { sessionId, userId, storedAt: Date.now() };
  notify();
  // The payload is captured now, at record time; only the write is serialized
  // behind any earlier mirror operation, so a later record always lands after
  // an earlier one and no write can jump a sign-out delete.
  const serialized = JSON.stringify(record);
  chainMirror(async () => {
    await mirrorRecord(serialized);
  });
}

/**
 * The session to reopen for the signed-in account, or null when the record
 * belongs to another account (or none was recorded).
 */
export function getLastOpenedSession(userId: string | null): string | null {
  void hydrate();
  if (userId === null || record === null || record.userId !== userId) {
    return null;
  }
  return record.sessionId;
}

/**
 * Subscribe to record changes — the `useSyncExternalStore` contract. The
 * subscription starts the restart read, so a restored record re-renders the
 * subscriber, including a record a retry recovers after a refused first read.
 */
export function subscribeLastOpenedSession(listener: () => void): () => void {
  listeners.add(listener);
  void hydrate();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The snapshotted session id for change detection only. This is the raw record
 * id; callers must read the id they open through `getLastOpenedSession(userId)`
 * so another account's session is never offered.
 */
export function getLastOpenedSessionSnapshot(): string | null {
  return record?.sessionId ?? null;
}

/** Drop the record from memory and from the SecureStore mirror. */
export function clearLastOpenedSession(): void {
  const hadRecord = record !== null;
  // Bump before the clear so an in-flight restart read cannot repopulate the
  // record after the caller dropped it.
  epoch += 1;
  record = null;
  // The caller has just established that there is no record, so this is the
  // answer for the run: a later reader must not ask the mirror again and restore
  // the record the clear removed. That matters because the delete below is
  // queued behind the mirror chain and is skipped outright while the device is
  // locked, so a read that ran before it landed would bring the record back.
  disarmUnlockRetry();
  hydration = { status: 'answered' };
  if (hadRecord) {
    notify();
  }
  // Serialized behind any earlier mirror operation, so an in-flight write can
  // never land after this delete. The in-memory clear is already visible.
  chainMirror(async () => {
    await dropMirroredRecord();
  });
}

// ── Injection seams used by the pure suites ────────────────────────────────

export function _setLastOpenedSessionForTests(next: LastOpenedSessionRecord | null): void {
  epoch += 1;
  record = next;
}

/** Re-run the restart read from the current mirror (a simulated restart). */
export async function _hydrateLastOpenedSessionForTests(): Promise<void> {
  hydration = { status: 'idle' };
  await hydrate();
}

export function _resetLastOpenedSessionForTests(): void {
  record = null;
  epoch = 0;
  hydration = { status: 'idle' };
  mirrorTail = null;
  listeners.clear();
  disarmUnlockRetry();
}

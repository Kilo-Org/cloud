import { z } from 'zod';

import { LAST_OPENED_SESSION_KEY } from '@/lib/storage-keys';
import { reportSecureStoreFailure } from '@/lib/telemetry/secure-store-events';

/**
 * The durable "Open last session" record behind the launcher shortcut and the
 * quick-settings tile. The in-memory record is the source of truth for the
 * current JS run and SecureStore is only a mirror so the choice survives a
 * restart. `userId` scopes the record to its account, so one account is never
 * offered another account's session; a record for a different account reads as
 * null and needs no sign-out wiring.
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

type SecureStoreLike = {
  setItemAsync: (key: string, value: string) => Promise<void>;
  getItemAsync: (key: string) => Promise<string | null>;
  deleteItemAsync: (key: string) => Promise<void>;
};

// Injection seam so the pure suites do not load expo-secure-store
// (→ expo-modules-core → RN). Mirrors the glanceable persist pattern.
let secureStoreForTests: SecureStoreLike | null = null;

function getSecureStore(): SecureStoreLike {
  if (secureStoreForTests) {
    return secureStoreForTests;
  }
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  return require('expo-secure-store') as SecureStoreLike;
}

let record: LastOpenedSessionRecord | null = null;
let hydration: Promise<void> | null = null;
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
  try {
    await getSecureStore().setItemAsync(LAST_OPENED_SESSION_KEY, serialized);
  } catch (error) {
    // An absent or older development client has no secure store, and a failed
    // mirror leaves the in-memory record authoritative. Reported at warning
    // level so a keychain failure is visible.
    reportSecureStoreFailure('write', error);
  }
}

/** Best-effort SecureStore delete; an absent store has nothing to delete. */
async function dropMirroredRecord(): Promise<void> {
  try {
    await getSecureStore().deleteItemAsync(LAST_OPENED_SESSION_KEY);
  } catch (error) {
    // An absent or older development client has no secure store, and a failed
    // delete leaves the record to be discarded on the next write.
    reportSecureStoreFailure('delete', error);
  }
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
 * Restore the in-memory record after a JS restart. Best effort: a failed or
 * malformed read leaves the in-memory record null. A write that lands during
 * the read owns the state and skips the stale persisted record.
 */
async function restore(): Promise<void> {
  const startEpoch = epoch;
  try {
    const raw = await getSecureStore().getItemAsync(LAST_OPENED_SESSION_KEY);
    if (raw === null || epoch !== startEpoch || record !== null) {
      return;
    }
    const parsed = parseStoredRecord(raw);
    if (parsed !== null) {
      record = parsed;
      notify();
    }
  } catch (error) {
    // A mirror that cannot be read is treated as absent; the next write fills it.
    reportSecureStoreFailure('read', error);
  }
}

async function hydrate(): Promise<void> {
  hydration ??= restore();
  await hydration;
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
 * subscriber.
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

export function _setSecureStoreForTests(store: SecureStoreLike | null): void {
  secureStoreForTests = store;
}

export function _setLastOpenedSessionForTests(next: LastOpenedSessionRecord | null): void {
  epoch += 1;
  record = next;
}

/** Re-run the restart read from the current mirror (a simulated restart). */
export async function _hydrateLastOpenedSessionForTests(): Promise<void> {
  hydration = null;
  await hydrate();
}

export function _resetLastOpenedSessionForTests(): void {
  record = null;
  epoch = 0;
  hydration = null;
  mirrorTail = null;
  listeners.clear();
  secureStoreForTests = null;
}

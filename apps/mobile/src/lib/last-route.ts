import { z } from 'zod';

import { LAST_ROUTE_KEY } from '@/lib/storage-keys';
import { isConcreteLastRouteHref } from '@/lib/last-route-recordable';
import { reportSecureStoreFailure } from '@/lib/telemetry/secure-store-events';

/**
 * The durable "last focused in-app route" record behind the relaunch restore.
 *
 * Android recreates a killed task with its original base Intent, so a stale
 * deep link (a session link from a notification or a launcher entry) replays
 * on every cold start and the app reopens on that link's route — for a session
 * that may be long gone, that is the session not-found screen. This record
 * names the route the person actually had on screen when the process died, so
 * the root layout can repair the restored route onto it.
 *
 * The in-memory record is the source of truth for the current JS run;
 * SecureStore is only a mirror so the record survives the kill. `userId`
 * scopes the record to its account, so one account never restores another
 * account's route; a record for a different account reads as null and needs no
 * sign-out wiring beyond the same-process clear.
 */

export type LastRouteRecord = {
  /** The concrete Expo Router href of the focused screen, e.g.
   * `/(app)/(tabs)/(3_profile)/profiles/p1/variables`. */
  href: string;
  userId: string;
  storedAt: number;
};

const lastRouteSchema = z.object({
  href: z.string().min(1).max(512),
  userId: z.string().min(1),
  storedAt: z.number(),
});

type SecureStoreLike = {
  setItemAsync: (key: string, value: string) => Promise<void>;
  getItemAsync: (key: string) => Promise<string | null>;
  deleteItemAsync: (key: string) => Promise<void>;
};

// Injection seam so the pure suites do not load expo-secure-store
// (→ expo-modules-core → RN). Mirrors the last-opened-session pattern.
let secureStoreForTests: SecureStoreLike | null = null;

function getSecureStore(): SecureStoreLike {
  if (secureStoreForTests) {
    return secureStoreForTests;
  }
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  return require('expo-secure-store') as SecureStoreLike;
}

let record: LastRouteRecord | null = null;
let hydration: Promise<void> | null = null;
// False until the restart read has settled (found, absent, or failed). The
// relaunch repair must not read the record before this, or a settle that runs
// ahead of the SecureStore read would latch "no record" and never repair.
let hydrated = false;
// Monotonic epoch bumped on every in-memory write and every clear, so a record
// written while the restart read is pending can never be clobbered by the
// stale persisted record, and a clear cannot be undone by a late read.
let epoch = 0;
// Bumped when `hydrated` flips, so a useSyncExternalStore subscriber re-renders
// once the restart read settles.
let hydrationVersion = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Parse a stored record; a corrupt, unreadable, or placeholder-bearing mirror reads as absent. */
function parseStoredRecord(raw: string): LastRouteRecord | null {
  try {
    const result = lastRouteSchema.safeParse(JSON.parse(raw));
    if (!result.success) {
      return null;
    }
    // A record written before hrefs were concrete names a route pattern
    // (`profiles/[profileId]/variables`); restoring it opens a screen whose
    // data reads cannot resolve, so it is dropped instead of replayed once.
    return isConcreteLastRouteHref(result.data.href) ? result.data : null;
  } catch {
    return null;
  }
}

/** Best-effort SecureStore write; the in-memory record is the source of truth. */
async function mirrorRecord(serialized: string): Promise<void> {
  try {
    await getSecureStore().setItemAsync(LAST_ROUTE_KEY, serialized);
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
    await getSecureStore().deleteItemAsync(LAST_ROUTE_KEY);
  } catch (error) {
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
  const run = async (): Promise<void> => {
    if (mirrorTail !== null) {
      await mirrorTail;
    }
    await operation();
  };
  mirrorTail = run();
}

/**
 * Restore the in-memory record after a JS restart. Best effort: a failed or
 * malformed read leaves the in-memory record null. A write or clear that lands
 * during the read owns the state and skips the stale persisted record.
 */
async function restore(): Promise<void> {
  const startEpoch = epoch;
  try {
    const raw = await getSecureStore().getItemAsync(LAST_ROUTE_KEY);
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
  } finally {
    // Settled regardless of outcome, and only once: the subscribers the repair
    // re-render needs already hold the subscription that started this read.
    if (!hydrated) {
      hydrated = true;
      hydrationVersion += 1;
      notify();
    }
  }
}

async function hydrate(): Promise<void> {
  hydration ??= restore();
  await hydration;
}

/**
 * Remember the route an account had focused. A null account records nothing:
 * the restore is an account-scoped feature, and a signed-out launch has no
 * route worth repairing (auth gates own it). A record written before the
 * relaunch repair consumed the restored record is dropped: on a cold start
 * the first commit is the base Intent's restored route itself, and it must
 * not overwrite the record the repair still has to read.
 *
 * Returns whether the write was accepted, so a caller can distinguish
 * "recorded" from "held until the repair latches".
 */
export function recordLastRoute(href: string, userId: string | null): boolean {
  if (userId === null || href.length === 0) {
    return false;
  }
  // Until the relaunch repair consumed the restored record, a write would
  // overwrite it with the cold start's first committed route (the base
  // Intent's destination itself) before the repair can read it. Recording
  // opens when the repair latched; on a process that started with no persisted
  // record, `consumeLastRouteForRepair` latches the same way, so ordinary
  // navigation recording still works there.
  if (!repairEvaluated) {
    return false;
  }
  epoch += 1;
  record = { href, userId, storedAt: Date.now() };
  notify();
  // The payload is captured now, at record time; only the write is serialized
  // behind any earlier mirror operation, so a later record always lands after
  // an earlier one and no write can jump a sign-out delete.
  const serialized = JSON.stringify(record);
  chainMirror(async () => {
    await mirrorRecord(serialized);
  });
  return true;
}

/**
 * The route to reopen for the signed-in account, or null when the record
 * belongs to another account (or none was recorded).
 */
export function getLastRoute(userId: string | null): string | null {
  void hydrate();
  if (userId === null || record === null || record.userId !== userId) {
    return null;
  }
  return record.href;
}

/** The snapshotted record for change detection only. */
export function getLastRouteSnapshot(): LastRouteRecord | null {
  return record;
}

/** True once the restart read has settled; the repair must wait for this. */
export function isLastRouteHydrated(): boolean {
  return hydrated;
}

/** The hydration state version, for re-render subscription. */
export function getLastRouteHydrationVersion(): number {
  return hydrationVersion;
}

/**
 * Subscribe to record changes — the `useSyncExternalStore` contract. The
 * subscription starts the restart read, so a restored record re-renders the
 * subscriber.
 */
export function subscribeLastRoute(listener: () => void): () => void {
  listeners.add(listener);
  void hydrate();
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Drop the record from memory and from the SecureStore mirror, so the next
 * account's launch never restores the previous account's route.
 */
export function clearLastRoute(): void {
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

// Whether the relaunch repair has evaluated the restored record. The recorder
// holds writes while this is false, so the cold start's first navigation
// commit — the base Intent's restored route itself — cannot overwrite the
// persisted record before the repair reads it. Flips once the repair ran, or
// when a write is legitimate (the account navigated after repair, or the
// record was absent and nothing could be repaired).
let repairEvaluated = false;

/** Hold the focused route until the root layout remounts and restores it on Retry. */
export function prepareLastRouteRepair(): void {
  repairEvaluated = false;
}

/**
 * Read-and-latch for the relaunch repair: opens recording from then on (see
 * `recordLastRoute`) and returns the persisted record for the account, or
 * null when there is none (or it belongs to another account). The
 * repair-once semantics live in the caller's own latch; this only hands out
 * the record that survived the process death.
 */
export function consumeLastRouteForRepair(userId: string | null): string | null {
  repairEvaluated = true;
  if (userId === null || record === null || record.userId !== userId) {
    return null;
  }
  return record.href;
}

// ── Injection seams used by the pure suites ────────────────────────────────

export function _setSecureStoreForTests(store: SecureStoreLike | null): void {
  secureStoreForTests = store;
}

export function _setLastRouteForTests(next: LastRouteRecord | null): void {
  epoch += 1;
  record = next;
}

/** Re-run the restart read from the current mirror (a simulated restart). */
export async function _hydrateLastRouteForTests(): Promise<void> {
  hydration = null;
  await hydrate();
}

export function _resetLastRouteForTests(): void {
  record = null;
  epoch = 0;
  hydration = null;
  hydrated = false;
  hydrationVersion = 0;
  repairEvaluated = false;
  mirrorTail = null;
  listeners.clear();
  secureStoreForTests = null;
}

import {
  type GlanceableAgentsSnapshot,
  glanceableAgentsSnapshotSchema,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { reportSecureStoreFailure } from '@/lib/telemetry/secure-store-events';

import { type GlanceableSink } from './sink-registry';

/**
 * Durable mirror of the last glanceable snapshot and its scope key, for JS
 * restart fencing only. The snapshot holds generic status, counts, timestamps
 * and an opaque scope key — never titles, ids, or other raw content.
 *
 * iOS widgets read the snapshot through expo-widgets `updateSnapshot` /
 * `updateTimeline`; Android widgets read through `react-native-android-widget`
 * storage. This store exists so the background push handler can compare an
 * incoming scope key without React context.
 */

// SecureStore keys are defined here (not storage-keys.ts) so this module stays
// self-contained; nothing else owns these two keys.
const GLANCEABLE_SNAPSHOT_KEY = 'glanceable-snapshot';
const GLANCEABLE_SCOPE_KEY = 'glanceable-scope-key';

type SecureStoreLike = {
  setItemAsync: (key: string, value: string) => Promise<void>;
  getItemAsync: (key: string) => Promise<string | null>;
};

// Test-only override so pure suites do not load expo-secure-store
// (→ expo-modules-core → RN). Mirrors the deep-link-launch pattern.
let secureStoreForTests: SecureStoreLike | null = null;

function getSecureStore(): SecureStoreLike {
  if (secureStoreForTests) {
    return secureStoreForTests;
  }
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  return require('expo-secure-store') as SecureStoreLike;
}

let lastSnapshot: GlanceableAgentsSnapshot | null = null;
let localScopeKey: string | null = null;

// Monotonic epoch bumped on every in-memory write. Restore captures it before
// its async read and only fills when it is unchanged, so a live publish during
// the read can never be clobbered by a stale persisted record.
let persistEpoch = 0;

// True when the last restore could not read the persisted mirror. A null
// in-memory snapshot then means "unknown", not "nothing persisted": the record
// may exist and name a card owner, so a caller that retires cards on a null
// snapshot has to check this first.
let restoreUnavailable = false;

// How many restores have a read in flight right now. While this is non-zero a
// null snapshot is "not read yet", not "nothing persisted": the mirror may still
// name a card owner, so a caller that retires cards on a null snapshot must wait
// until every in-flight read has consulted the record. A count, not a one-way
// latch: a later restore re-opens the window, and overlapping reads keep it open
// until the last one lands.
let restoresInFlight = 0;

// Callers parked on the read window (see `whenGlanceableRestoresSettle`). A
// caller that deferred work on an unsettled read waits here, so the last read
// to land resumes it instead of dropping the work.
let settleWaiters: (() => void)[] = [];

export function getLastGlanceableSnapshot(): GlanceableAgentsSnapshot | null {
  return lastSnapshot;
}

/**
 * True when the last `restorePersistedGlanceable` could not read the durable
 * mirror. Distinct from an absent record: the keychain may still hold a
 * snapshot that names an owner, so a null in-memory state is not proof that
 * nothing owns the surface.
 */
export function isGlanceableRestoreUnavailable(): boolean {
  return restoreUnavailable;
}

/**
 * True when no `restorePersistedGlanceable` read is in flight. While one is, a
 * null in-memory snapshot is not proof that nothing owns the surface: the
 * mirror read may still fill it, and its record may name a card owner. Every
 * read re-opens the window, not just the first. Distinct from
 * `isGlanceableRestoreUnavailable`, which reports a read that failed rather
 * than one that has not finished.
 */
export function isGlanceableRestoreSettled(): boolean {
  return restoresInFlight === 0;
}

/**
 * Resolve once no `restorePersistedGlanceable` read is in flight. A caller that
 * had to defer work on an unsettled read — a sweep that must not retire cards
 * on a null snapshot that only means "not read yet" — waits here and resumes
 * when the last read lands, instead of dropping the work until some later
 * foreground or publisher update happens to come by.
 *
 * Resolves at once when nothing is in flight, so the caller can await it on
 * every path. A read that fails still settles, so a waiter always resumes and
 * re-reads the state, including `isGlanceableRestoreUnavailable`.
 */
export async function whenGlanceableRestoresSettle(): Promise<void> {
  if (restoresInFlight === 0) {
    return;
  }
  await new Promise<void>(resolve => {
    settleWaiters.push(resolve);
  });
}

export function getLocalScopeKey(): string | null {
  return localScopeKey;
}

/**
 * One fire-and-forget mirror write. The in-memory snapshot is authoritative,
 * so a failed write is reported at warning level with the stable write
 * fingerprint and never rejects: a `void`-ed native rejection here would
 * surface as an unhandled error with no caller able to recover it.
 */
async function mirrorSnapshotWrite(operation: () => Promise<void>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    reportSecureStoreFailure('write', error);
  }
}

/** In-memory write plus a fire-and-forget SecureStore mirror. */
function persistSnapshot(snapshot: GlanceableAgentsSnapshot): void {
  persistEpoch += 1;
  lastSnapshot = snapshot;
  localScopeKey = snapshot.scopeKey;
  void mirrorSnapshotWrite(async () => {
    await getSecureStore().setItemAsync(GLANCEABLE_SNAPSHOT_KEY, JSON.stringify(snapshot));
  });
  void mirrorSnapshotWrite(async () => {
    await getSecureStore().setItemAsync(GLANCEABLE_SCOPE_KEY, snapshot.scopeKey);
  });
}

/** Parse a stored record with the shared schema; a malformed record is absent. */
function parseStoredSnapshot(raw: string): GlanceableAgentsSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = glanceableAgentsSnapshotSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Restore the in-memory state from SecureStore after a JS restart. Best
 * effort: a failed read keeps the null in-memory state. A live write during
 * the read owns the state, so the stale persisted record is skipped. An
 * already-set in-memory state (a remount) is never overwritten: only a real
 * JS restart starts null and must restore from the persisted record.
 */
export async function restorePersistedGlanceable(): Promise<void> {
  const startEpoch = persistEpoch;
  restoreUnavailable = false;
  // Re-open the read window on every restore, not just the first: a later read
  // can fill the snapshot just as the first one could, so a null snapshot is
  // "not read yet" until this read lands too.
  restoresInFlight += 1;
  try {
    const [rawSnapshot, rawScope] = await Promise.all([
      getSecureStore().getItemAsync(GLANCEABLE_SNAPSHOT_KEY),
      getSecureStore().getItemAsync(GLANCEABLE_SCOPE_KEY),
    ]);
    // A live write landed during the read: it owns the state; skip the fill.
    if (persistEpoch !== startEpoch) {
      return;
    }
    // A remount keeps the module alive, so a logout or privacy blank written
    // before restore owns the state and must not be clobbered by a stale disk
    // record from the prior session.
    if (rawSnapshot !== null && lastSnapshot === null) {
      const parsed = parseStoredSnapshot(rawSnapshot);
      if (parsed !== null) {
        lastSnapshot = parsed;
      }
    }
    if (rawScope !== null && localScopeKey === null) {
      localScopeKey = rawScope;
    }
  } catch (error) {
    // A malformed mirror is treated as absent; the publisher repopulates it.
    // A read failure is different: the record may be there and own a card, so
    // record the uncertainty for callers that act on a null snapshot. Reported
    // at warning level so a keychain/keystore failure is visible instead of
    // looking like an empty mirror.
    restoreUnavailable = true;
    reportSecureStoreFailure('read', error);
  } finally {
    // Settled on every path, including the live-write early return and a failed
    // read, so a null snapshot stops meaning "the read has not finished" once
    // every in-flight read has consulted the record.
    restoresInFlight -= 1;
    if (restoresInFlight === 0) {
      const waiting = settleWaiters;
      settleWaiters = [];
      for (const resume of waiting) {
        resume();
      }
    }
  }
}

/** The persist sink owns no native surface, so endImmediate is a no-op. */
export const persistGlanceableSink: GlanceableSink = {
  publish(snapshot) {
    persistSnapshot(snapshot);
  },
  endImmediate() {
    // The widget snapshot stays for later reads; nothing to end.
  },
  startOrUpdate(snapshot) {
    persistSnapshot(snapshot);
  },
};

// ── Test-only helpers ──────────────────────────────────────────────────────

export function _setSecureStoreForTests(store: SecureStoreLike | null): void {
  secureStoreForTests = store;
}

export function _setLastGlanceableSnapshotForTests(
  snapshot: GlanceableAgentsSnapshot | null
): void {
  persistEpoch += 1;
  lastSnapshot = snapshot;
  localScopeKey = snapshot?.scopeKey ?? null;
  // Seeding the mirror models a completed restore: callers act on this state as
  // the read's result, the same way `restorePersistedGlanceable` would.
  restoresInFlight = 0;
}

export function _setGlanceableRestoreUnavailableForTests(unavailable: boolean): void {
  restoreUnavailable = unavailable;
}

export function _resetGlanceablePersistForTests(): void {
  persistEpoch = 0;
  lastSnapshot = null;
  localScopeKey = null;
  restoreUnavailable = false;
  restoresInFlight = 0;
  settleWaiters = [];
  secureStoreForTests = null;
}

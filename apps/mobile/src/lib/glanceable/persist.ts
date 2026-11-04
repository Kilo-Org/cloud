import {
  buildOpaqueScopeKey,
  type GlanceableAgentsSnapshot,
  glanceableAgentsSnapshotSchema,
} from '@kilocode/app-shared/glanceable-agents-snapshot';

import { reportSecureStoreFailure } from '@/lib/telemetry/secure-store-events';
import {
  _resetHomeWidgetDataForTests,
  _setHomeWidgetStoreForTests,
  restoreHomeWidgetData,
} from './home-widget-data';
import { readSignedInScope, type SignedInScope } from './scope';

import { type GlanceableSink } from './sink-registry';

/**
 * Durable mirror of the last glanceable snapshot, which carries its own scope
 * key, for JS restart fencing only. One serialized record per publish, so a
 * restart reads the last publish whole: snapshot and scope key always come from
 * the same one. The snapshot holds generic status, counts, timestamps and an
 * opaque scope key — never titles, ids, or other raw content.
 *
 * iOS widgets read the snapshot through expo-widgets `updateSnapshot` /
 * `updateTimeline`; Android widgets read through `react-native-android-widget`
 * storage. This store exists so the background push handler can compare an
 * incoming scope key without React context.
 */

// SecureStore keys are defined here (not storage-keys.ts) so this module stays
// self-contained; nothing else owns them.
const GLANCEABLE_SNAPSHOT_KEY = 'glanceable-snapshot';
// The previous release wrote the scope key beside the snapshot. One record now
// carries both, so this key is only read: a record it wrote before the upgrade
// still restores, and a scope key it left without a snapshot still fills the
// scope the way it does today.
const GLANCEABLE_LEGACY_SCOPE_KEY = 'glanceable-scope-key';

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

// The mirror writes, chained one after the other the way `waiting-ask.ts` and
// `home-widget-data.ts` chain theirs. A later publish is issued only once the
// previous one has settled, so two rapid publishes can never land out of order:
// a terminal blank always overwrites the happy frame published before it,
// instead of racing it.
let mirrorWrite: Promise<void> | null = null;

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

// What the restore learned about the record it put in memory. `none` means it
// restored no record, so only frames written in this process are in memory;
// `unknown` means the identity read did not complete, which is not a mismatch.
// Decided from the same reads that fill the state, so a caller asks
// synchronously instead of re-reading the keychain on every surface write.
type RestoredScope = 'none' | 'match' | 'mismatch' | 'unknown';
let restoredScope: RestoredScope = 'none';

// True once this process wrote the in-memory snapshot itself. A frame it wrote
// is already fenced by the context that produced it; only a restored record
// needs `restoredScope` resolved before a surface may draw it.
let snapshotWrittenInProcess = false;

export function getLastGlanceableSnapshot(): GlanceableAgentsSnapshot | null {
  return lastSnapshot;
}

/**
 * The snapshot a surface may draw: the frame this process wrote, or a restored
 * record only when it belongs to the signed-in scope. Sinks and republish paths
 * read this instead of {@link getLastGlanceableSnapshot}, whose value also feeds
 * the revision floor and the ownership questions a null must not answer.
 */
export function getGlanceableSnapshotForSignedInScope(): GlanceableAgentsSnapshot | null {
  if (lastSnapshot === null) {
    return null;
  }
  if (snapshotWrittenInProcess) {
    return lastSnapshot;
  }
  // A record the signed-in scope matched, or one whose scope could not be
  // checked at all, is drawable; only a confirmed different scope is not.
  return restoredScope === 'match' || restoredScope === 'unknown' ? lastSnapshot : null;
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
 * One mirror write, issued only after the previous one settled. The snapshot
 * carries its own scope key, so one write is the whole record: a restart can
 * never pair one publish's snapshot with another publish's scope key. The
 * in-memory snapshot is authoritative, so a failed write is reported at warning
 * level with the stable write fingerprint and never rejects: a `void`-ed native
 * rejection here would surface as an unhandled error with no caller able to
 * recover it.
 */
async function mirrorSnapshotAfter(previous: Promise<void> | null, raw: string): Promise<void> {
  if (previous !== null) {
    await previous;
  }
  try {
    await getSecureStore().setItemAsync(GLANCEABLE_SNAPSHOT_KEY, raw);
  } catch (error) {
    reportSecureStoreFailure('write', error);
  }
}

/** In-memory write plus a fire-and-forget SecureStore mirror. */
function persistSnapshot(snapshot: GlanceableAgentsSnapshot): void {
  persistEpoch += 1;
  snapshotWrittenInProcess = true;
  lastSnapshot = snapshot;
  localScopeKey = snapshot.scopeKey;
  mirrorWrite = mirrorSnapshotAfter(mirrorWrite, JSON.stringify(snapshot));
}

/** How a record's scope key relates to the signed-in scope the restore read. */
function scopeRelation(recordScopeKey: string, signedInScope: SignedInScope): RestoredScope {
  if (signedInScope.status === 'unavailable') {
    return 'unknown';
  }
  return signedInScope.status === 'known' && scopeKeyOf(signedInScope) === recordScopeKey
    ? 'match'
    : 'mismatch';
}

/** The opaque key of a known signed-in scope; the one form the fence compares. */
function scopeKeyOf(scope: Extract<SignedInScope, { status: 'known' }>): string {
  return buildOpaqueScopeKey({ userId: scope.userId, organizationId: scope.organizationId });
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
 * The scope key of the signed-in account, or `null` when it is not known: no
 * signed-in account or a read that did not complete. Callers that must not act
 * on an unconfirmed scope treat `null` as a refusal.
 */
export async function getAuthenticatedGlanceableScopeKey(): Promise<string | null> {
  const signedInScope = await readSignedInScope(getSecureStore());
  return signedInScope.status === 'known' ? scopeKeyOf(signedInScope) : null;
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
    const rawSnapshot = await getSecureStore().getItemAsync(GLANCEABLE_SNAPSHOT_KEY);
    // A live write landed during the read: it owns the state; skip the fill.
    if (persistEpoch !== startEpoch) {
      return;
    }
    const stored = rawSnapshot === null ? null : parseStoredSnapshot(rawSnapshot);
    const authenticatedScope = await readSignedInScope(getSecureStore());
    // A live write that landed during the identity read owns the state, the
    // same as one that landed during the record read: skip the fill rather than
    // clobber it with what was read before it.
    if (persistEpoch !== startEpoch) {
      return;
    }
    const authenticatedScopeKey =
      authenticatedScope.status === 'known' ? scopeKeyOf(authenticatedScope) : null;
    if (stored === null) {
      // No usable record: a scope key the previous release wrote on its own
      // still names the scope, the same way it did before this record existed.
      const legacyScopeKey = await getSecureStore().getItemAsync(GLANCEABLE_LEGACY_SCOPE_KEY);
      localScopeKey ??= legacyScopeKey;
      restoredScope = 'none';
    } else {
      lastSnapshot ??= stored;
      // The record carries its own scope key, so the restored snapshot and the
      // restored scope always come from the same publish.
      localScopeKey ??= stored.scopeKey;
      // The record's own scope key says which context wrote it, not which one
      // holds the device now, so a surface may draw it only on a match.
      restoredScope = scopeRelation(stored.scopeKey, authenticatedScope);
    }
    await restoreHomeWidgetData(authenticatedScopeKey);
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
  _setHomeWidgetStoreForTests(store);
}

export function _setLastGlanceableSnapshotForTests(
  snapshot: GlanceableAgentsSnapshot | null
): void {
  persistEpoch += 1;
  lastSnapshot = snapshot;
  // Callers seed a completed restore, so the record is the state this process
  // acts on rather than a record still to be verified.
  snapshotWrittenInProcess = snapshot !== null;
  restoredScope = 'none';
  localScopeKey = snapshot?.scopeKey ?? null;
  // Seeding the mirror models a completed restore: callers act on this state as
  // the read's result, the same way `restorePersistedGlanceable` would.
  restoresInFlight = 0;
}

export function _setGlanceableRestoreUnavailableForTests(unavailable: boolean): void {
  restoreUnavailable = unavailable;
}

/** Settle the mirror chain so a case can assert what landed on disk. */
export async function _flushGlanceableMirrorForTests(): Promise<void> {
  await mirrorWrite;
}

export function _resetGlanceablePersistForTests(): void {
  persistEpoch = 0;
  mirrorWrite = null;
  lastSnapshot = null;
  restoredScope = 'none';
  snapshotWrittenInProcess = false;
  localScopeKey = null;
  restoreUnavailable = false;
  restoresInFlight = 0;
  settleWaiters = [];
  secureStoreForTests = null;
  _resetHomeWidgetDataForTests();
}

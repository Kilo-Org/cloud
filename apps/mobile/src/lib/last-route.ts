/* eslint-disable max-lines -- one restart-read store: the hydration union, its three retry arms (timer, unlock, resume), the repair hand-off, and the test seams share one set of invariants, and splitting them would spread the single "failed is not absent" rule across files */
import { z } from 'zod';

import { currentRouteHref } from '@/lib/current-route-href';
import { LAST_ROUTE_KEY } from '@/lib/storage-keys';
import { isConcreteLastRouteHref, isUnrestorableLastRouteHref } from '@/lib/last-route-recordable';
import { normalizedRoutePath } from '@/lib/last-route-repair';
import {
  assertProtectedDataAvailable,
  isProtectedDataAvailable,
  ProtectedDataUnavailableError,
  subscribeToProtectedDataAvailable,
} from '@/lib/protected-data';
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

/** The subset of React Native's `AppState` this module reads. */
type AppStateLike = {
  readonly addEventListener: (
    type: 'change',
    listener: (state: string) => void
  ) => { readonly remove: () => void };
};

// Injection seam, like the store one above: a suite that never retries a read
// must not load react-native, and a suite that drives the resume retry needs a
// listener registry the test controls.
let appStateForTests: AppStateLike | null = null;

function getAppState(): AppStateLike | null {
  if (appStateForTests) {
    return appStateForTests;
  }
  try {
    // The lazy native module: react-native's own types cannot be loaded here,
    // and the app build hands over the real `AppState`.
    // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
    const native = require('react-native') as { AppState: AppStateLike };
    return native.AppState;
  } catch {
    // A host without the native module (a suite that never loads react-native)
    // cannot hear a resume; the next reader and the unlock retry still re-read.
    return null;
  }
}

let record: LastRouteRecord | null = null;
// How many times the restart read runs before the launch settles without it.
const READ_ATTEMPTS = 4;
// The wait before the next attempt, the same cadence as
// `lib/auth/secure-store-read`: the four attempts finish within 1.75 s.
const READ_RETRY_DELAYS_MS = [250, 500, 1000] as const;
const [FIRST_RETRY_DELAY_MS, SECOND_RETRY_DELAY_MS, THIRD_RETRY_DELAY_MS] = READ_RETRY_DELAYS_MS;

/** The wait before the read after `attempt`; fixed entries keep the tuple typed. */
function readRetryDelayMs(attempt: number): number {
  if (attempt <= 1) {
    return FIRST_RETRY_DELAY_MS;
  }
  return attempt === 2 ? SECOND_RETRY_DELAY_MS : THIRD_RETRY_DELAY_MS;
}

/**
 * Where the restart read stands. `answered` is the only settled state that
 * stays for the run: the store answered — a record, a malformed record, or no
 * record — and asking again would return the same bytes. `failed` means the
 * read never answered, so it must not read as "no record": the relaunch repair
 * would latch an absence the store never stated and the cold start's route
 * would overwrite the stored one. It stays `failed` (not `answered`) for
 * exactly that reason, even after the budget is spent.
 */
type Hydration =
  | { readonly status: 'idle' }
  | { readonly status: 'pending'; readonly promise: Promise<void> }
  | { readonly status: 'answered' }
  | {
      readonly status: 'failed';
      /** The reads spent so far; the next one is `attempts + 1`. */
      readonly attempts: number;
      // null: the launch may settle; only a later reader, resume, or unlock
      // retries.
      readonly nextAttemptAt: number | null;
    };
let hydration: Hydration = { status: 'idle' };
// The one timer armed for the next backoff step. It exists because the launch's
// settle waits for the read: a refusal must not hold the first frame, so the
// tree settles while the read keeps retrying behind it.
let retryTimer: ReturnType<typeof setTimeout> | null = null;
// The one re-read armed for the next unlock after a locked refusal, like
// `last-opened-session`'s unlock retry.
let unlockRetry: (() => void) | null = null;
// The one re-read armed for the next resume once the budget is spent.
let resumeRetry: (() => void) | null = null;
// One report per process for a read that never answered.
let readFailureReported = false;
// True once the read settled with no attempt left. A later read that fails
// again keeps that settled state and stays silent, so no reader can turn the
// failure into a stream of notifications.
let readExhausted = false;
// Monotonic epoch bumped on every in-memory write and every clear, so a record
// written while the restart read is pending can never be clobbered by the
// stale persisted record, and a clear cannot be undone by a late read.
let epoch = 0;
// Bumped when the hydration state settles, so a useSyncExternalStore subscriber
// re-renders: once when the read answers, and once when it spends its budget.
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
    const href = currentRouteHref(result.data.href);
    if (!isConcreteLastRouteHref(href)) {
      return null;
    }
    // An older build could record a route this rule no longer accepts (a picker
    // sheet, or another transient sheet). Replaying one would reopen it alone
    // over the start route, so it reads as absent like any other unusable
    // record and the repair leaves the start route alone.
    if (isUnrestorableLastRouteHref(href)) {
      return null;
    }
    return { ...result.data, href };
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

function disarmRetryTimer(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

/** Arm the one re-read for the next backoff step; a newer refusal replaces it. */
function armRetryTimer(delayMs: number): void {
  disarmRetryTimer();
  retryTimer = setTimeout(() => {
    retryTimer = null;
    const current = hydration;
    if (current.status !== 'failed' || current.nextAttemptAt === null) {
      return;
    }
    // The deadline is now: the timer may fire a hair early, and `hydrate` must
    // not read that as "still inside the backoff" and drop the retry. The spent
    // attempts stay, so the next read is the one after them.
    hydration = { status: 'failed', attempts: current.attempts, nextAttemptAt: Date.now() };
    void hydrate();
  }, delayMs);
}

function disarmUnlockRetry(): void {
  unlockRetry?.();
}

/**
 * Arm one re-read for the next unlock: while the device is locked every
 * keychain call is refused before it reaches the store, so the answer becomes
 * readable at the unlock.
 */
function armUnlockRetry(): void {
  if (unlockRetry !== null) {
    return;
  }
  const release = subscribeToProtectedDataAvailable(() => {
    disarmUnlockRetry();
    // A spent budget has no wait left, so the unlock retries at once; a read
    // that answered, or a newer read in flight, owns the state.
    if (hydration.status !== 'failed') {
      return;
    }
    void hydrate();
  });
  unlockRetry = () => {
    release();
    unlockRetry = null;
  };
}

function disarmResumeRetry(): void {
  resumeRetry?.();
}

/**
 * Arm one re-read for the next resume, so a read whose budget is spent still
 * answers when the person comes back to the app.
 */
function armResumeRetry(): void {
  if (resumeRetry !== null) {
    return;
  }
  const appState = getAppState();
  if (appState === null) {
    return;
  }
  const subscription = appState.addEventListener('change', nextState => {
    if (nextState !== 'active' || hydration.status !== 'failed') {
      return;
    }
    disarmResumeRetry();
    void hydrate();
  });
  resumeRetry = () => {
    subscription.remove();
    resumeRetry = null;
  };
}

function disarmRetries(): void {
  disarmRetryTimer();
  disarmUnlockRetry();
  disarmResumeRetry();
}

/** Settle the read as answered, once: the store answered, or a write or clear owns the state. */
function settleAnswered(): void {
  disarmRetries();
  readExhausted = false;
  if (hydration.status === 'answered') {
    return;
  }
  hydration = { status: 'answered' };
  hydrationVersion += 1;
  notify();
}

/**
 * Settle the read as failed with no attempt left. The launch may settle, but
 * the record must not: an absent answer would latch the repair over a record
 * the store may still return, so this state keeps recording held and the
 * repair unlatched. It notifies only when it is entered, so a later read that
 * fails again cannot form a render loop.
 */
function settleExhausted(attempts: number): void {
  const alreadySettled = readExhausted;
  readExhausted = true;
  hydration = { status: 'failed', attempts, nextAttemptAt: null };
  if (alreadySettled) {
    // The launch already settled on this failure: reassign the same state so a
    // later silent re-read cannot leave it pending, and stay silent.
    return;
  }
  hydrationVersion += 1;
  notify();
}

/** One read: the protected-data guard first, so a locked device never reaches the store. */
async function readMirroredRecord(): Promise<string | null> {
  assertProtectedDataAvailable();
  // The `await` is load-bearing: it turns the guard's throw into this function's
  // rejection, so `restore` records the failure a task later instead of while
  // `hydrate` is still storing the pending state.
  const raw = await getSecureStore().getItemAsync(LAST_ROUTE_KEY);
  return raw;
}

/**
 * Restore the in-memory record after a JS restart. Best effort: a read that
 * refuses is retried on a bounded backoff, and one that never answers leaves
 * the run `failed` rather than "no record". A write or clear that lands during
 * the read owns the state and skips the stale persisted record.
 */
async function restore(attempt: number): Promise<void> {
  const startEpoch = epoch;
  try {
    const raw = await readMirroredRecord();
    // A write or a clear that landed while this read was in flight owns the
    // state, and its answer is newer than these bytes.
    if (epoch !== startEpoch) {
      settleAnswered();
      return;
    }
    if (record === null) {
      const parsed = raw === null ? null : parseStoredRecord(raw);
      if (parsed !== null) {
        record = parsed;
      }
    }
    // The read answered — a record, a malformed record, or nothing stored —
    // so this is the run's answer and no later reader asks the store again.
    settleAnswered();
  } catch (error) {
    if (epoch !== startEpoch) {
      settleAnswered();
      return;
    }
    disarmRetries();
    // A locked device refuses every call before it reaches the store: no
    // attempt is spent, nothing is filed, and the one unlock re-read answers.
    if (!isProtectedDataAvailable() || error instanceof ProtectedDataUnavailableError) {
      settleExhausted(attempt - 1);
      armUnlockRetry();
      return;
    }
    if (attempt < READ_ATTEMPTS) {
      const delayMs = readRetryDelayMs(attempt);
      hydration = { status: 'failed', attempts: attempt, nextAttemptAt: Date.now() + delayMs };
      armRetryTimer(delayMs);
      return;
    }
    // The budget is spent: report once, let the launch settle, and retry only
    // when the app comes back or a reader asks again.
    if (!readFailureReported) {
      readFailureReported = true;
      reportSecureStoreFailure('read', error);
    }
    settleExhausted(attempt);
    armResumeRetry();
  }
}

async function hydrate(): Promise<void> {
  const current = hydration;
  // An answered read is the run's answer, and an attempt already in flight is
  // shared by every reader that arrives meanwhile.
  if (current.status === 'answered') {
    return;
  }
  if (current.status === 'pending') {
    await current.promise;
    return;
  }
  // A retry still inside its backoff must wait for its timer; a spent budget
  // has no timer left, so a reader, resume, or unlock retries at once.
  if (
    current.status === 'failed' &&
    current.nextAttemptAt !== null &&
    Date.now() < current.nextAttemptAt
  ) {
    return;
  }
  const attempt = current.status === 'failed' ? current.attempts + 1 : 1;
  const promise = restore(attempt);
  hydration = { status: 'pending', promise };
  await promise;
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
  // Recording opens when the repair latched; on a process that started with no persisted
  // record, `consumeLastRouteForRepair` latches the same way, so ordinary
  // navigation recording still works there.
  if (!repairEvaluated) {
    return false;
  }
  epoch += 1;
  record = { href, userId, storedAt: Date.now() };
  notify();
  // The payload is captured now, at record time, not when the queued write runs.
  const serialized = JSON.stringify(record);
  chainMirror(async () => {
    await mirrorRecord(serialized);
  });
  return true;
}

/**
 * The route to reopen for the signed-in account, or null when the record
 * belongs to another account (or none was recorded). A restart read still in
 * flight, or one that never answered, also answers null: callers that need the
 * answer itself gate on `isLastRouteHydrated` (and `isLastRouteReadSettled` for
 * the launch) instead of reading this.
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

/** True once the restart read answered; the repair and recording must wait for this. */
export function isLastRouteHydrated(): boolean {
  return hydration.status === 'answered';
}

/**
 * True once the launch may settle: the read answered, or it failed with no
 * attempt left. A settled failure is not an answer, so the repair stays
 * unlatched and recording stays held until a later read answers.
 */
export function isLastRouteReadSettled(): boolean {
  const current = hydration;
  if (current.status === 'answered') {
    return true;
  }
  return current.status === 'failed' && current.nextAttemptAt === null;
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
  const wasAnswered = hydration.status === 'answered';
  // Bump before the clear so an in-flight restart read cannot repopulate the
  // record after the caller dropped it.
  epoch += 1;
  record = null;
  // A clear is this run's answer: a queued retry must not restore the record
  // the caller just dropped, and the repair must not wait on it.
  disarmRetries();
  readExhausted = false;
  hydration = { status: 'answered' };
  if (hadRecord || !wasAnswered) {
    hydrationVersion += 1;
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
 *
 * A read still in flight or one that failed has no answer to repair from, so
 * this hands out null and leaves recording held: latching there would open
 * recording over a record the store may still return.
 */
export function consumeLastRouteForRepair(userId: string | null): string | null {
  if (hydration.status === 'pending' || hydration.status === 'failed') {
    return null;
  }
  repairEvaluated = true;
  if (userId === null || record === null || record.userId !== userId) {
    return null;
  }
  return record.href;
}

// The route the relaunch repair opened, until a screen takes the mark. The
// repair restores a stored destination, not one the person chose in this
// process, so the screen it lands on must not dead-end: a session the server
// no longer has falls back to the start screen instead. Only the first screen
// that asks takes the mark, so a later navigation to the same route — a tap, a
// link, a retry — is an ordinary open that keeps its own not-found answer.
let restoredRouteOpenHref: string | null = null;

/** Record the stored route the relaunch repair is about to open. */
export function noteRestoredRouteOpen(href: string): void {
  restoredRouteOpenHref = href;
}

/**
 * Whether the route the repair opened is this one. One-shot: the first screen
 * that asks consumes the mark, whether or not its path matches.
 */
export function consumeRestoredRouteOpen(pathname: string): boolean {
  const href = restoredRouteOpenHref;
  if (href === null) {
    return false;
  }
  restoredRouteOpenHref = null;
  return normalizedRoutePath(href) === normalizedRoutePath(pathname);
}

// ── Injection seams used by the pure suites ────────────────────────────────

export function _setSecureStoreForTests(store: SecureStoreLike | null): void {
  secureStoreForTests = store;
}

export function _setAppStateForTests(next: AppStateLike | null): void {
  appStateForTests = next;
}

export function _setLastRouteForTests(next: LastRouteRecord | null): void {
  epoch += 1;
  record = next;
}

/** Re-run the restart read from the current mirror (a simulated restart). */
export async function _hydrateLastRouteForTests(): Promise<void> {
  disarmRetries();
  readExhausted = false;
  hydration = { status: 'idle' };
  await hydrate();
}

export function _resetLastRouteForTests(): void {
  record = null;
  epoch = 0;
  disarmRetries();
  hydration = { status: 'idle' };
  readFailureReported = false;
  readExhausted = false;
  hydrationVersion = 0;
  repairEvaluated = false;
  restoredRouteOpenHref = null;
  mirrorTail = null;
  listeners.clear();
  secureStoreForTests = null;
  appStateForTests = null;
}

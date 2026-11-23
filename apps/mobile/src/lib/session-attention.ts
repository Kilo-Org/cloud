/* eslint-disable max-lines -- one cohesive ack store: identity, persistence, hydration, reconcile, and the test seams read together */
import { parseTimestamp } from '@kilocode/app-shared/utils';
import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import { chainSave } from '@/lib/hooks/save-chain';
import { SESSION_ATTENTION_KEY } from '@/lib/storage-keys';

/**
 * Durable session-attention ack store for the mobile Agents session list
 * "needs input" indicator.
 *
 * Acks are written only when the user successfully answers, skips, or
 * responds to a permission — never on merely opening the detail screen.
 * Entries are persisted to the encrypted KV store (DEC-01) under one storage
 * key and hydrated at module init, so an ack survives an app restart. No
 * secrets are persisted: entries hold only session ids, raise ids, the
 * attention status, and ack/expiry timestamps.
 *
 * Raise identity is `statusUpdatedAt ?? status` (stored rows carry server
 * `status_updated_at`; remote active-only rows carry none so identity
 * degrades to the status string). Priority and action are derived, never
 * stored: `question` sorts before `permission`, and the action is the
 * existing navigation to the session detail.
 *
 * The encrypted KV is loaded lazily so the synchronous store API stays free
 * of the native SQLCipher chain (and importable in node tests). Beside the
 * entries the store publishes one hydration phase: `loading` from module init
 * until the KV read settles, `ready` once the persisted entries (or a
 * genuinely empty store) are readable, and `failed` when the KV is
 * unavailable, the read rejects, or the blob does not parse. Consumers hold
 * their needs-input affordance while the phase is `loading`: an unloaded store
 * answers "not acked" for every raise, so drawing then would show a badge for
 * a raise the person already dismissed and withdraw it a moment later. A
 * `failed` phase is settled — it is never retried and never hangs — so
 * consumers stop holding, and it answers exactly as `ready` does: an ack this
 * run recorded still hides its raise, and with no ack the badge derives from
 * the server status. Failing that way can add a badge the person dismissed,
 * but it can never suppress a genuine raise. A commit recorded after a failed
 * read is kept in memory only and never replaces the stored blob: the read
 * never merged it, so writing the map would drop the acks the blob still
 * holds. Those survive to the next launch, which hydrates them normally.
 *
 * No backend or tRPC imports: this is a mobile-local module so the web client
 * can keep its own copy. The one shared import is the pure timestamp reader,
 * because Hermes cannot parse the PostgreSQL text a stored row carries.
 */

const ATTENTION_STATUSES = new Set(['question', 'permission']);

/** Attention acks expire 7 days after the ack. */
export const SESSION_ATTENTION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/** Item key for the single serialized entries blob under the storage key. */
const SESSION_ATTENTION_ENTRY_KEY = 'entries';

const persistedEntrySchema = z.object({
  sessionId: z.string(),
  raiseId: z.string().nullable(),
  status: z.string().nullable(),
  ackedAt: z.number().nullable(),
  expiresAt: z.number().nullable(),
});

const persistedEntriesSchema = z.array(persistedEntrySchema);

export function sessionNeedsInput(status: string | null | undefined): boolean {
  return status != null && ATTENTION_STATUSES.has(status);
}

/**
 * True when two raise ids name the same raise.
 *
 * Raise identity is `statusUpdatedAt ?? status`, and the time arrives in two
 * spellings: ISO 8601 from the live rows, raw PostgreSQL text
 * (`2026-10-12 09:45:12.945+00`) from stored rows. Same instant, different
 * string, so a comparison that only used string equality would clear an ack
 * the moment the other surface reconciled the same raise. `parseTimestamp` is
 * the app's reader for both spellings: Hermes' `Date` cannot parse the
 * PostgreSQL form on its own.
 */
export function sameRaise(a: string | null, b: string | null): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null) {
    return false;
  }
  const at = parseTimestamp(a).getTime();
  const bt = parseTimestamp(b).getTime();
  return !Number.isNaN(at) && !Number.isNaN(bt) && at === bt;
}

/**
 * What an ack names: the raise the person answered, or only the kind of raise
 * it was.
 */
type AckIdentity =
  | { readonly kind: 'raise'; readonly raiseId: string }
  | { readonly kind: 'status'; readonly status: string };

/**
 * True when a raise id dates at or before `ackedAt`. A raise id that is not a
 * timestamp says nothing about order, so it answers false.
 */
function orderedAtOrBefore(raiseId: string | null, ackedAt: number): boolean {
  if (raiseId === null) {
    return false;
  }
  const at = parseTimestamp(raiseId).getTime();
  return !Number.isNaN(at) && at <= ackedAt;
}

/** True when a raise id is not a timestamp, which is what "the status alone" is written as. */
function isUndatedRaise(raiseId: string | null): boolean {
  return raiseId === null || Number.isNaN(parseTimestamp(raiseId).getTime());
}

/**
 * One durable entry: the answer a person gave, or the raise a re-raise cleared.
 *
 * `answered` names what the answer was about. A `raise` identity suppresses
 * that raise only; a `status` identity names the kind of raise the person
 * answered when the surface that answered carried no row time.
 * `expiresAt === null` only appears in a blob written before acks expired, and
 * those are kept.
 */
type AttentionEntry =
  | {
      readonly kind: 'acked';
      readonly answered: AckIdentity;
      readonly status: string | null;
      readonly ackedAt: number;
      readonly expiresAt: number | null;
    }
  | { readonly kind: 'cleared'; readonly raiseId: string | null; readonly status: string | null };

/** The flat shape the blob stores, and the shape the old type had. */
type PersistedAttentionEntry = {
  sessionId: string;
  raiseId: string | null;
  status: string | null;
  ackedAt: number | null;
  expiresAt: number | null;
};

/**
 * The one hydration phase the store publishes beside its entries.
 *
 * `loading` — module init until the KV read settles.
 * `ready` — the read completed: persisted entries applied, or genuinely empty.
 * `failed` — the KV is unavailable, the read rejected, or the blob does not
 * parse. Settled: never retried, so consumers must not wait on it; they fail
 * open instead. A commit recorded after a failed read stays in memory only and
 * does not replace the stored blob, so the acks this run never merged survive
 * and the next launch hydrates them.
 */
export type SessionAttentionHydration = 'loading' | 'ready' | 'failed';

type AttentionStore = {
  listeners: Set<() => void>;
  entries: Map<string, AttentionEntry>;
  revision: number;
  hydration: SessionAttentionHydration;
};

const STORE_KEY = '__kiloSessionAttentionStore__';
const globalScope = globalThis as typeof globalThis & { [STORE_KEY]?: AttentionStore };
const store: AttentionStore = (globalScope[STORE_KEY] ??= {
  listeners: new Set<() => void>(),
  entries: new Map<string, AttentionEntry>(),
  revision: 0,
  hydration: 'loading',
});

// ── Encrypted KV (lazy) ─────────────────────────────────────────────────────

/** The encrypted-KV calls this module uses, kept structural so the lazy
 * import never pulls the native SQLCipher chain into this module's types. */
type AttentionKv = {
  getItem: (scope: string, k: string) => Promise<string | null>;
  setItem: (scope: string, k: string, v: string) => Promise<void>;
  clearScope: (scope: string) => Promise<void>;
};

let kvModulePromise: Promise<AttentionKv | null> | null = null;

// eslint-disable-next-line require-await, @typescript-eslint/require-await -- single-flight must memoize the lazy import synchronously before any await; the awaits live inside the memoized import chain (same pattern as openDatabase in encrypted-kv.ts)
async function loadKv(): Promise<AttentionKv | null> {
  kvModulePromise ??= (async () => {
    try {
      return await import('@/lib/persist/encrypted-kv');
    } catch {
      // The native SQLCipher chain cannot load in a node test environment.
      // Treat it as "KV unavailable": the in-memory store stays authoritative.
      return null;
    }
  })();
  return kvModulePromise;
}

// ── Persistence ─────────────────────────────────────────────────────────────

/**
 * The flat entry the blob stores: the shape a reader of an older build wrote
 * and the one this build reads back.
 */
function projectedEntry(entry: AttentionEntry): Omit<PersistedAttentionEntry, 'sessionId'> {
  if (entry.kind === 'cleared') {
    return { raiseId: entry.raiseId, status: entry.status, ackedAt: null, expiresAt: null };
  }
  return {
    raiseId: entry.answered.kind === 'raise' ? entry.answered.raiseId : entry.answered.status,
    status: entry.status,
    ackedAt: entry.ackedAt,
    expiresAt: entry.expiresAt,
  };
}

function serializeEntries(): string {
  const entries: PersistedAttentionEntry[] = [];
  for (const [sessionId, entry] of store.entries) {
    entries.push({ sessionId, ...projectedEntry(entry) });
  }
  return JSON.stringify(entries);
}

async function writeEntriesSafely(serialized: string): Promise<void> {
  const kv = await loadKv();
  if (!kv) {
    return;
  }
  try {
    await kv.setItem(SESSION_ATTENTION_KEY, SESSION_ATTENTION_ENTRY_KEY, serialized);
  } catch {
    // Swallow: a failed write keeps the in-memory store authoritative and
    // retries on the next bump.
  }
}

// Writes are chained through `chainSave` so the last bump's state lands last;
// each write is fire-and-forget and never rejects.
let lastWrite: Promise<void> | null = null;

function persistEntries(): void {
  lastWrite = chainSave(SESSION_ATTENTION_KEY, async () => {
    // Start the read when none ran (a reset), else join the settled one. A
    // write that lands during the hydration window must not overwrite the
    // persisted blob before the hydrated entries are applied, or it erases
    // other sessions' acks.
    await hydrate();
    // The blob was never merged this run (no KV, or the read rejected), so the
    // map is not the whole record: writing it would drop the acks the blob
    // still holds. The ack stays in memory, which is what the settled `failed`
    // phase promises, and the next launch hydrates the blob as it stands.
    if (!blobReadUnderEpoch) {
      return;
    }
    const serialized = serializeEntries();
    await writeEntriesSafely(serialized);
  });
}

// ── Hydration ───────────────────────────────────────────────────────────────

function parseEntries(raw: string): PersistedAttentionEntry[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = persistedEntriesSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/** What a stored blob did to the in-memory entries. */
type HydrationApply = 'applied' | 'unchanged' | 'invalid';

function applyHydratedEntries(raw: string): HydrationApply {
  const entries = parseEntries(raw);
  if (!entries) {
    return 'invalid';
  }
  const now = Date.now();
  let applied = false;
  for (const entry of entries) {
    const raiseId = entry.raiseId;
    const live = entry.expiresAt === null || entry.expiresAt > now;
    /* A mutation that landed after hydration began must win over the stale
       persisted entry: a present in-memory entry means this session already
       changed this run, so the persisted snapshot is out of date. An ack that
       names no raise (written before acks carried one) suppresses nothing. */
    const fresh = raiseId !== null && !store.entries.has(entry.sessionId);
    if (fresh && live) {
      store.entries.set(entry.sessionId, hydratedEntry(entry, raiseId));
      applied = true;
    }
  }
  return applied ? 'applied' : 'unchanged';
}

/** The one entry a stored row describes: a cleared raise, or the answer it recorded. */
function hydratedEntry(entry: PersistedAttentionEntry, raiseId: string): AttentionEntry {
  if (entry.ackedAt === null) {
    return { kind: 'cleared', raiseId, status: entry.status };
  }
  return {
    kind: 'acked',
    /* A row whose raise id is its status was answered from a surface with no
       row time: it names the kind of raise, not the raise. */
    answered:
      raiseId === entry.status ? { kind: 'status', status: raiseId } : { kind: 'raise', raiseId },
    status: entry.status,
    ackedAt: entry.ackedAt,
    expiresAt: entry.expiresAt,
  };
}

let hydrationPromise: Promise<void> | null = null;

// Set only by a read that returned under the current account boundary. The
// in-memory map is the whole record only once that happened: before it, the
// map may be missing rows the stored blob still holds, so a write that
// replaced the blob would drop them.
let blobReadUnderEpoch = false;

// Bumped at every account boundary (sign-out, test reset) so a read that
// started before it neither applies the signed-out account's rows nor
// persists the emptied map it never saw.
let hydrationEpoch = 0;

// Dev-only: a bundle-time delay so the loading window is observable on a
// device (`EXPO_PUBLIC_*` is inlined by Metro, so the value is baked into the
// bundle and never read at runtime). Default 0 keeps the shipped timing; a
// value that is not a positive finite number is ignored.
const configuredHydrationDelayMs = __DEV__
  ? Number(process.env.EXPO_PUBLIC_SESSION_ATTENTION_HYDRATION_DELAY_MS ?? 0)
  : 0;
const devHydrationDelayMs =
  Number.isFinite(configuredHydrationDelayMs) && configuredHydrationDelayMs > 0
    ? configuredHydrationDelayMs
    : 0;

/**
 * Settle the hydration phase, bumping the revision when the phase changed — or
 * when the same settle also changed the entries, so a restored ack still
 * notifies subscribers exactly once.
 */
function settleHydration(next: SessionAttentionHydration, entriesChanged = false): void {
  const changed = store.hydration !== next;
  store.hydration = next;
  if (!changed && !entriesChanged) {
    return;
  }
  // Restored acks (and the settled phase itself) change badge decisions:
  // notify subscribers so rows re-render and re-evaluate `isAttentionAcked`.
  bumpRevision();
}

/** The one persisted read: the stored blob, the absence of one, or a failed read. */
type PersistedRead =
  | { readonly kind: 'read'; readonly raw: string | null }
  | { readonly kind: 'error' };

async function readPersistedEntries(kv: AttentionKv): Promise<PersistedRead> {
  try {
    return {
      kind: 'read',
      raw: await kv.getItem(SESSION_ATTENTION_KEY, SESSION_ATTENTION_ENTRY_KEY),
    };
  } catch {
    return { kind: 'error' };
  }
}

// eslint-disable-next-line require-await, @typescript-eslint/require-await -- single-flight must memoize hydration synchronously before any await; the awaits live inside the memoized hydration chain (same pattern as openDatabase in encrypted-kv.ts)
async function hydrate(): Promise<void> {
  if (hydrationPromise) {
    return hydrationPromise;
  }
  const epoch = hydrationEpoch;
  hydrationPromise = (async () => {
    if (devHydrationDelayMs > 0) {
      const { promise, resolve } = Promise.withResolvers<undefined>();
      setTimeout(resolve, devHydrationDelayMs);
      await promise;
    }
    const kv = await loadKv();
    // The account boundary moved while this read was being set up: what it
    // would apply belongs to the signed-out account, and sign-out already
    // settled the phase, so touch neither.
    if (epoch !== hydrationEpoch) {
      return;
    }
    if (!kv) {
      // No encrypted KV on this build: settled and empty, and it never retries.
      settleHydration('failed');
      return;
    }
    const read = await readPersistedEntries(kv);
    // Same boundary, crossed while the read was in flight: drop the result
    // rather than restore rows into a map the clear just emptied.
    if (epoch !== hydrationEpoch) {
      return;
    }
    if (read.kind === 'error') {
      // Unreadable KV: settled, so consumers fail open on the server status.
      // The blob was never merged, so it stays not-known-read and no write
      // replaces it this run.
      settleHydration('failed');
      return;
    }
    // The read returned, so the map now holds everything the blob does — or
    // the blob was absent/unreadable as data, which the map may replace.
    blobReadUnderEpoch = true;
    if (read.raw === null) {
      // No blob is a genuinely empty store, not a failure.
      settleHydration('ready');
      return;
    }
    // The single hydration bump: applying entries and settling to `ready` are
    // the same transition, so an applied blob still notifies exactly once.
    const applied = applyHydratedEntries(read.raw);
    if (applied === 'invalid') {
      settleHydration('failed');
      return;
    }
    settleHydration('ready', applied === 'applied');
  })();
  return hydrationPromise;
}

void hydrate();

// ── Store ───────────────────────────────────────────────────────────────────

function bumpRevision(): void {
  store.revision += 1;
  // Isolate subscribers: one throwing listener must not prevent the rest from
  // being notified of the revision change.
  for (const listener of store.listeners) {
    try {
      listener();
    } catch {
      // A subscriber's own error must not break store notification.
    }
  }
}

function commit(): void {
  bumpRevision();
  persistEntries();
}

export function subscribe(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => {
    store.listeners.delete(listener);
  };
}

export function getRevisionSnapshot(): number {
  return store.revision;
}

/** The settled/unsettled hydration phase. Stable primitive, safe as a store snapshot. */
export function getHydrationSnapshot(): SessionAttentionHydration {
  return store.hydration;
}

/**
 * Server snapshot for `useSyncExternalStore`. Stable across calls so the
 * hook is SSR / RN-safe; the real revision is read on the client.
 */
function getServerSnapshot(): number {
  return 0;
}

/** Server snapshot for the hydration phase: nothing has hydrated on the server. */
function getHydrationServerSnapshot(): SessionAttentionHydration {
  return 'loading';
}

/**
 * Enders for the settle waits a caller armed, so a test reset can end them
 * instead of leaving a timer (or a latch nobody resolves) behind for the next
 * case.
 */
const settledWaitReleases = new Set<() => void>();

/**
 * Resolves once hydration has settled (`ready` or `failed`), or after
 * `deadlineMs`, whichever comes first. A background process that republishes
 * the glanceable surfaces must not be withheld indefinitely by a store that
 * has not settled, so the deadline is the caller's; the state is unchanged by
 * the wait, so a caller that times out can still read `getHydrationSnapshot()`.
 *
 * Never rejects: `hydrationPromise` settles its own read failures into
 * `failed` instead of throwing.
 */
export async function whenSessionAttentionHydrationSettled(deadlineMs: number): Promise<void> {
  if (store.hydration !== 'loading') {
    return;
  }
  const inFlight = hydrationPromise;
  const { promise: deadline, resolve: deadlineReached } = Promise.withResolvers<undefined>();
  const timer = setTimeout(deadlineReached, deadlineMs);
  function release(): void {
    clearTimeout(timer);
    deadlineReached(undefined);
  }
  settledWaitReleases.add(release);
  try {
    // No read in flight (only a test reset leaves that): the phase has not
    // settled and nothing will settle it, so only the deadline ends the wait.
    await (inFlight === null ? deadline : Promise.race([inFlight, deadline]));
  } finally {
    settledWaitReleases.delete(release);
    clearTimeout(timer);
  }
}

/**
 * Hide the needs-input badge immediately after a successful answer / skip /
 * permission response, before the server status round-trip lands.
 * `reconcileSessionAttention` clears the entry once status leaves attention.
 *
 * The ack names the raise the user answered, so it can only ever suppress that
 * raise: `statusUpdatedAt` when the answered row carried it, the status alone
 * otherwise. A caller that has no timestamp keeps the raise an existing entry
 * already tracks for the same status — the raise that was on screen when the
 * answer happened.
 *
 * A late response cannot replace a newer dated raise already tracked here.
 *
 * Re-acking the raise already acked changes nothing — skip the bump so we
 * don't fire a redundant global re-render.
 */
export function ackSessionAttention(
  sessionId: string,
  status: string,
  statusUpdatedAt?: string | null
): void {
  const entry = store.entries.get(sessionId);
  // Only a cleared entry tracks the raise still waiting for an answer; an acked
  // entry's raise was answered already and must not be reused for a new one.
  const trackedRaise = entry?.kind === 'cleared' && entry.status === status ? entry.raiseId : null;
  const raiseId = statusUpdatedAt ?? trackedRaise ?? status;
  let knownRaise: string | null = null;
  if (entry !== undefined) {
    if (entry.kind === 'cleared') {
      knownRaise = entry.raiseId;
    } else if (entry.answered.kind === 'raise') {
      knownRaise = entry.answered.raiseId;
    } else {
      knownRaise = entry.answered.status;
    }
  }
  if (
    knownRaise !== null &&
    parseTimestamp(knownRaise).getTime() > parseTimestamp(raiseId).getTime()
  ) {
    return;
  }
  if (entry?.kind === 'acked' && sameRaise(knownRaise, raiseId)) {
    return;
  }
  const now = Date.now();
  store.entries.set(sessionId, {
    kind: 'acked',
    /* A raise id equal to the status is the status alone: the answer carried no
       row time, so it names the kind of raise, not the raise. */
    answered: raiseId === status ? { kind: 'status', status } : { kind: 'raise', raiseId },
    status,
    ackedAt: now,
    expiresAt: now + SESSION_ATTENTION_EXPIRY_MS,
  });
  commit();
}

/**
 * Reconcile the ack store against the latest observed status.
 *
 * `raiseId = statusUpdatedAt ?? status`.
 *
 * - expired entry: delete it and notify
 * - non-attention status: delete the entry (if any) and notify
 * - observed raise is the acked raise: no-op
 * - acked with its status alone and that same status observed: learn the raise
 *   (the ack keeps suppressing it; a later raise is then told apart)
 * - observation without a timestamp of the acked status: keep the ack — the
 *   observer cannot name the raise, and the badge it draws belongs to the
 *   raise the user answered
 * - any other raise: replace the raise and clear the ack (same-session
 *   re-raise) so the badge returns
 * - otherwise: no-op (does NOT bump the revision)
 */
export function reconcileSessionAttention(
  sessionId: string,
  status: string | null | undefined,
  statusUpdatedAt: string | null | undefined
): void {
  const existing = store.entries.get(sessionId);
  if (
    existing?.kind === 'acked' &&
    existing.expiresAt !== null &&
    existing.expiresAt <= Date.now()
  ) {
    store.entries.delete(sessionId);
    commit();
    return;
  }

  if (!sessionNeedsInput(status)) {
    if (store.entries.delete(sessionId)) {
      commit();
    }
    return;
  }

  const raiseId = statusUpdatedAt ?? status ?? null;
  const entry = store.entries.get(sessionId);
  if (!entry) {
    return;
  }

  if (entry.kind === 'cleared') {
    // Cleared ack (re-raise): keep tracking the current raise, still unacked.
    if (!sameRaise(entry.raiseId, raiseId)) {
      store.entries.set(sessionId, { kind: 'cleared', raiseId, status: status ?? null });
      commit();
    }
    return;
  }

  const answeredRaise =
    entry.answered.kind === 'raise' ? entry.answered.raiseId : entry.answered.status;
  if (sameRaise(answeredRaise, raiseId)) {
    return;
  }

  if (
    entry.answered.kind === 'status' &&
    entry.answered.status === status &&
    (isUndatedRaise(raiseId) || orderedAtOrBefore(raiseId, entry.ackedAt))
  ) {
    /* Acked with the status alone: an observation that cannot be ordered after
       the answer is the raise the user answered. Learn it, so a later dated
       raise is told apart. An undateable id is the status string in production,
       so learning it can never steal a later dated raise. */
    store.entries.set(sessionId, {
      kind: 'acked',
      answered: { kind: 'raise', raiseId: raiseId ?? entry.answered.status },
      status,
      ackedAt: entry.ackedAt,
      expiresAt: entry.expiresAt,
    });
    commit();
    return;
  }

  if (statusUpdatedAt == null && entry.status === status) {
    return;
  }

  store.entries.set(sessionId, { kind: 'cleared', raiseId, status: status ?? null });
  commit();
}

/**
 * Sign-out cleanup: drop every ack from memory and from the encrypted KV.
 *
 * Entries carry the signed-out account's session ids, so they must not survive
 * the teardown — the next account hydrating this scope would both read the
 * previous user's ids and let a stale ack suppress its own badge. The delete
 * is chained through the same FIFO as the writes so a queued bump cannot
 * re-persist the blob afterwards, and hydration is re-armed so the next
 * signed-in account starts from an empty store.
 *
 * The hydration phase settles to `ready`, never back to `loading`: the store is
 * now authoritatively empty for the next account, and nothing re-runs hydrate
 * for this run. Returning to `loading` would hold every badge until some read
 * that never comes.
 *
 * Best effort: a storage failure is swallowed so it can never abort sign-out.
 */
export async function clearSessionAttentionForSignOut(): Promise<void> {
  // A read already in flight belongs to the signed-out account: invalidate it
  // before the wipe, or its rows land in the map the clear just emptied.
  hydrationEpoch += 1;
  store.entries.clear();
  // One bump, through the settle helper: the phase moves to `ready` (or, when it
  // already is, the cleared entries are the change). Nothing re-runs hydrate for
  // this run, so the phase must never move back to `loading`.
  settleHydration('ready', true);
  lastWrite = chainSave(SESSION_ATTENTION_KEY, async () => {
    const kv = await loadKv();
    if (!kv) {
      return;
    }
    try {
      await kv.clearScope(SESSION_ATTENTION_KEY);
    } catch {
      // Swallow: sign-out must not abort because a clear failed.
    }
  });
  await lastWrite;
  // Re-arm hydration so the next account does not read the cleared blob
  // through the settled promise of this run, and require its own read before
  // any write replaces the blob: a write queued across this reset must not
  // persist the emptied map over the scope the clear just deleted.
  hydrationPromise = null;
  blobReadUnderEpoch = false;
}

/**
 * One raise as a reader sees it: the identity the row gives (`statusUpdatedAt ??
 * status`) plus, when the caller knows it, the row's status.
 */
export type AttentionRaise = {
  raiseId: string | null;
  status?: string | null;
};

/**
 * True when the ack names this raise.
 *
 * Raise ids are compared as identities, so a stored row's PostgreSQL text and a
 * live row's ISO form of the same instant are the same raise. A row the surface
 * cannot date (`raiseId === status`), or an ack written from a status-only
 * answer, matches by status: a miss there would draw the badge for a raise the
 * user already answered. A caller that knows the row's status time asks about
 * exactly one raise, so a re-raise under the same status shows again.
 */
export function isAttentionAcked(sessionId: string, raise: AttentionRaise): boolean {
  const entry = store.entries.get(sessionId);
  if (entry?.kind !== 'acked') {
    return false;
  }
  const answeredRaise =
    entry.answered.kind === 'raise' ? entry.answered.raiseId : entry.answered.status;
  if (sameRaise(answeredRaise, raise.raiseId)) {
    return true;
  }
  if (raise.raiseId === null || entry.status === null) {
    return false;
  }
  // A reader that cannot date its row names the status it shows: answered for
  // both variants, which is what the tray, launcher and remote rows read.
  if (raise.raiseId === entry.status) {
    return true;
  }
  // A status-only ack answers a raise of the same kind it cannot order: one
  // dated at or before the answer. A dated raise after the answer, or one of
  // another kind, is a raise the person has not answered.
  return (
    entry.answered.kind === 'status' &&
    raise.status === entry.answered.status &&
    orderedAtOrBefore(raise.raiseId, entry.ackedAt)
  );
}

/** What a needs-input surface does with its affordance for one row. */
export type NeedsInputVisibility = 'show' | 'hold' | 'hide';

/**
 * Decide one row's needs-input affordance from the server status, the store's
 * hydration phase, and whether this raise is acked.
 *
 * - `loading` — the ack store has not settled, so it answers "not acked" for
 *   every raise including one the person already dismissed: hold the
 *   affordance rather than draw a badge that would disappear a moment later.
 * - `failed` — the restored acks are unknowable, because the read failed and
 *   never retries. An ack this run recorded is a different matter: the entry
 *   map is authoritative for everything the process has learned, so a raise
 *   the person answered after the failed read stays hidden. With no ack, the
 *   badge derives from the server status alone — fail open, because a missing
 *   ack may add a badge the person dismissed but can never suppress a genuine
 *   raise.
 * - `ready` — hide only the raise the store knows was answered.
 *
 * `failed` therefore answers exactly as `ready` does; the phase stays distinct
 * because consumers must know the read settled (so they stop holding) and
 * because the failure itself is worth reporting.
 */
export function needsInputVisibility({
  status,
  hydration,
  isAcked,
}: {
  status: string | null | undefined;
  hydration: SessionAttentionHydration;
  isAcked: boolean;
}): NeedsInputVisibility {
  if (hydration === 'loading') {
    return 'hold';
  }
  if (!sessionNeedsInput(status)) {
    return 'hide';
  }
  return isAcked ? 'hide' : 'show';
}

/**
 * The visibility reader for a non-React caller that already holds the
 * hydration state (a widget, a notification planner, a background republish).
 * A component reads `needsInputVisibility` with `useSessionAttentionHydration`
 * so it re-renders when the phase settles.
 */
export function shouldShowNeedsInput(input: {
  status: string | null | undefined;
  hydration: SessionAttentionHydration;
  isAcked: boolean;
}): boolean {
  return needsInputVisibility(input) === 'show';
}

/**
 * Subscribe a component to the ack store's revision counter. When the
 * revision changes, the component re-renders and re-evaluates
 * `isAttentionAcked` for its session.
 */
export function useSessionAttentionRevision(): number {
  return useSyncExternalStore(subscribe, getRevisionSnapshot, getServerSnapshot);
}

/**
 * Subscribe a component to the hydration phase. Every transition bumps the
 * revision, so this re-renders when the phase settles ('loading' → `ready` /
 * `failed`); read it beside `isAttentionAcked` and pass both to
 * `needsInputVisibility`.
 */
export function useSessionAttentionHydration(): SessionAttentionHydration {
  return useSyncExternalStore(subscribe, getHydrationSnapshot, getHydrationServerSnapshot);
}

// ── Test-only helpers ───────────────────────────────────────────────────────

/**
 * Test-only: clear all acks, return the store to its pre-hydration phase, and
 * reset the revision counter so each test starts from a known state. A settle
 * wait an earlier case armed is released here, so no timer resolves into a
 * later case. Not for production use.
 */
export function __resetSessionAttentionForTests(): void {
  store.entries.clear();
  store.revision = 0;
  store.hydration = 'loading';
  // An abandoned read from an earlier case must not apply or persist into
  // this one.
  hydrationEpoch += 1;
  hydrationPromise = null;
  blobReadUnderEpoch = false;
  lastWrite = null;
  for (const release of settledWaitReleases) {
    release();
  }
  settledWaitReleases.clear();
}

/** Test-only: re-run hydration (a simulated restart) and return its promise. */
export async function __hydrateSessionAttentionForTests(): Promise<void> {
  hydrationPromise = null;
  await hydrate();
}

/** Test-only: await every queued fire-and-forget KV write. */
export async function __flushSessionAttentionWritesForTests(): Promise<void> {
  if (lastWrite) {
    await lastWrite;
  }
}

/**
 * Test-only: peek at a session's ack state (the `raiseId` projection) or
 * undefined when no entry exists. Kept as a projection for compatibility
 * with existing tests; use `__peekSessionAttentionEntryForTests` for the
 * full entry.
 */
export function __peekSessionAttentionForTests(
  sessionId: string
): { raiseId: string | null } | undefined {
  const entry = store.entries.get(sessionId);
  return entry === undefined ? undefined : { raiseId: projectedEntry(entry).raiseId };
}

/** Test-only: peek at the full entry for a session (or undefined), in the blob's flat shape. */
export function __peekSessionAttentionEntryForTests(
  sessionId: string
): Omit<PersistedAttentionEntry, 'sessionId'> | undefined {
  const entry = store.entries.get(sessionId);
  return entry === undefined ? undefined : projectedEntry(entry);
}

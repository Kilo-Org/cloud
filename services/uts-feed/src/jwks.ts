import {
  SignerKeysReadSchema,
  UTS_FEED_COUNT,
  UTS_SIGNER_COUNT,
  UTS_SIGNER_KEYS_HOLD_MS,
  type FeedKeysEntry,
  type SignerKeysAnswer,
  type SignerKeysBinding,
  type SignerKeysEntry,
  type UtsEnvironment,
  type UtsJwks,
  type UtsPublicJwk,
} from '@kilocode/uts-contracts';

/**
 * A set whose newest signer keys were read from their signer objects less than this long ago
 * serves with no new read. Past it, the first request starts one read in the background.
 */
export const KEY_SET_FRESH_MS = 10 * 1000;

/**
 * The oldest newest-signer-read a healthy feed Worker serves: past it, a request waits for the
 * read. It is the earlier 15 seconds plus the mint Worker's 2-second copy, so while the signer
 * reads succeed a signer key change reaches the key-set response within 17 seconds, and a
 * verifier within that plus its 5-minute `max-age` (design 5.6, 5.7).
 */
export const KEY_SET_MAX_SERVED_AGE_MS = 17 * 1000;

/**
 * An isolate starts a read at most once per this long, whatever the outcome, so it costs the mint
 * Worker at most one read per 10 seconds. A read gives up after this long (a later result is only
 * disposed), and a request waits at most this long for reads other requests started.
 */
export const KEY_SET_READ_GUARD_MS = 10 * 1000;

/**
 * No copy is shared between isolates. The Cache API is one cache per zone, shared by every Worker
 * on the zone, so a copy there could be written by another Worker; design 7 allows a shared cache
 * entry only under an HMAC from the workload's own secret bundle, which this Worker does not hold
 * yet. Each isolate reads on its own; requests inside one isolate share its read through `read`.
 */
const WAIT_STEP_MS = 20;

export type KeySetFailure =
  /** The read failed or timed out, or every signer failed; a later read can succeed. */
  | { status: 'unavailable' }
  /**
   * A deploy error: the mint Worker does not answer this caller (`refused`), its key-set shard
   * refused to load (`shard_refused`), a signer object refused to load and no other signer has
   * keys (`signer_refused`), or the answer is not a valid signer-keys answer (`invalid_answer`).
   */
  | {
      status: 'misconfigured';
      reason: 'refused' | 'shard_refused' | 'signer_refused' | 'invalid_answer';
    };

/**
 * `ageMs`: how long ago the newest keys in `body` were read from their signer object, the
 * response's `Age`. `oldestAgeMs`: the same for the oldest keys, which bounds the last-good hold.
 */
export type KeySetRead =
  | { status: 'ok'; body: string; ageMs: number; oldestAgeMs: number }
  | KeySetFailure;

type HeldSigner = { keys: UtsPublicJwk[]; readAt: number };

/** The key set of every signer held under 24 hours, serialized once per change. */
type ServedSet = { body: string; oldestReadAt: number; newestReadAt: number };

type ReadState =
  | { status: 'idle' }
  | { status: 'reading'; startedAt: number }
  | { status: 'succeeded'; startedAt: number }
  | { status: 'failed'; startedAt: number; failure: KeySetFailure };

/**
 * Isolate state, plain data only: a pending promise is never shared between requests, because
 * awaiting another request's I/O can hang once that request ends (design 7). A request that needs
 * a read another request started polls `read` instead. Each signer's and each feed object's keys
 * are held separately, with the time they were read from their object, so one failing object
 * leaves the others current. One state per environment, so no environment is served another's
 * keys.
 */
type FeedIsolate = {
  environment: UtsEnvironment;
  signers: ReadonlyArray<HeldSigner | null>;
  feeds: ReadonlyArray<HeldSigner | null>;
  served: ServedSet | null;
  read: ReadState;
};

let isolate: FeedIsolate | null = null;

type MintRead =
  | { status: 'answered'; answer: SignerKeysAnswer; receivedAt: number }
  | KeySetFailure;

const GUARD_EXPIRED = Symbol('guard expired');

/**
 * Runs the RPC disposer of `result`, which workerd gives every object an RPC call returns. A
 * result that is not an object, such as `null`, carries none.
 */
function disposeResult(result: unknown): void {
  if (typeof result !== 'object' || result === null || !(Symbol.dispose in result)) return;
  const dispose = result[Symbol.dispose];
  if (typeof dispose === 'function') dispose.call(result);
}

/**
 * Reads every signer's and both feed objects' keys from the mint Worker's `SignerKeys`
 * entrypoint over the service binding. A call that has not answered after the read guard is a
 * failed read; its result, if it still lands while this context lives, is disposed. Feed keys
 * carry `uts-feed-` kids and token keys `uts-token-` kids in the same `keys` array.
 */
async function readFromMint(mint: SignerKeysBinding): Promise<MintRead> {
  // Created in an async callback, so a binding that throws as it is called becomes a rejection
  // that the catch below answers.
  const call = Promise.try(async () => await mint.signerKeys());
  const guard = Promise.withResolvers<typeof GUARD_EXPIRED>();
  const timer = setTimeout(() => guard.resolve(GUARD_EXPIRED), KEY_SET_READ_GUARD_MS);
  // The call's result is unknown until validated, so it also covers the guard's symbol.
  let result: unknown;
  try {
    result = await Promise.race([call, guard.promise]);
  } catch (error) {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.failed', error: String(error) }));
    return { status: 'unavailable' };
  } finally {
    clearTimeout(timer);
  }
  if (result === GUARD_EXPIRED) {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.timed_out' }));
    void call.then(disposeResult, () => undefined);
    return { status: 'unavailable' };
  }
  // The parse copies the plain data out and never throws; the disposer is a symbol key, which it
  // leaves behind.
  const parsed = SignerKeysReadSchema.safeParse(result);
  disposeResult(result);
  if (!parsed.success) {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.invalid_answer' }));
    return { status: 'misconfigured', reason: 'invalid_answer' };
  }
  if (parsed.data.status === 'refused') {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.refused' }));
    return { status: 'misconfigured', reason: 'refused' };
  }
  if (parsed.data.status === 'misconfigured') {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.shard_refused' }));
    return { status: 'misconfigured', reason: 'shard_refused' };
  }
  const { answer } = parsed.data;
  const failed = [...answer.signers, ...(answer.feeds ?? [])].filter(
    entry => entry.status !== 'ok'
  );
  if (failed.length > 0) {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.signers_failed', failed }));
  }
  return { status: 'answered', answer, receivedAt: Date.now() };
}

type HeldObjects = Pick<FeedIsolate, 'signers' | 'feeds'>;

/**
 * The set to serve from the held keys at `now`: the keys of every signer, then of every feed
 * object, read under 24 hours ago, in object order. A `kid` names its object, and each object's
 * keys come from one validated answer, so no `kid` repeats. An object past the hold drops out: a
 * signer's tokens, or a feed object's heads, then fail verification.
 *
 * A set with no live signer is no set: a verifier must keep its own last good set rather than take
 * one that verifies no token, so the request answers 503 (or 500). `Age` counts from the newest
 * signer read only (design 5.7); feed keys count toward the oldest age, which bounds every key.
 */
function servedSet(held: HeldObjects, now: number): ServedSet | null {
  const isLive = (entry: HeldSigner | null): entry is HeldSigner =>
    entry !== null && now - entry.readAt < UTS_SIGNER_KEYS_HOLD_MS;
  const signers = held.signers.filter(isLive);
  const feeds = held.feeds.filter(isLive);
  const missing = {
    signers: held.signers.flatMap((entry, index) => (isLive(entry) ? [] : [index])),
    feeds: held.feeds.flatMap((entry, index) => (isLive(entry) ? [] : [index])),
  };
  if (missing.signers.length > 0 || missing.feeds.length > 0) {
    console.error(JSON.stringify({ event: 'uts_feed.key_set.signers_missing', ...missing }));
  }
  if (signers.length === 0) return null;
  const live = [...signers, ...feeds];
  return {
    body: JSON.stringify({ keys: live.flatMap(entry => entry.keys) } satisfies UtsJwks),
    oldestReadAt: Math.min(...live.map(entry => entry.readAt)),
    newestReadAt: Math.max(...signers.map(entry => entry.readAt)),
  };
}

/**
 * Takes each object's keys from the answer when they were read later than the keys held for it.
 * A read time later than the answer's arrival, from a clock ahead of this one, counts as the
 * arrival, so no keys can outlive their hold.
 */
function merge<Entry extends SignerKeysEntry | FeedKeysEntry>(
  current: ReadonlyArray<HeldSigner | null>,
  entries: readonly Entry[],
  indexOf: (entry: Entry) => number,
  receivedAt: number
): Array<HeldSigner | null> {
  const held = [...current];
  for (const entry of entries) {
    if (entry.status !== 'ok') continue;
    const readAt = Math.min(entry.readAt, receivedAt);
    const index = indexOf(entry);
    const previous = held[index] ?? null;
    if (previous === null || previous.readAt < readAt) held[index] = { keys: entry.keys, readAt };
  }
  return held;
}

/**
 * Runs one read and records its outcome. Keys newer than those held replace them signer by
 * signer, so a read that finishes late changes nothing a newer read brought.
 */
async function runRead(
  state: FeedIsolate,
  mint: SignerKeysBinding,
  startedAt: number
): Promise<void> {
  const result = await readFromMint(mint);
  let outcome: ReadState;
  if (result.status === 'answered') {
    state.signers = merge(state.signers, result.answer.signers, e => e.signer, result.receivedAt);
    state.feeds = merge(state.feeds, result.answer.feeds ?? [], e => e.feed, result.receivedAt);
    state.served = servedSet(state, Date.now());
    if (state.served !== null) {
      outcome = { status: 'succeeded', startedAt };
    } else {
      // No signer has keys: a refused signer object is a deploy error, anything else transient.
      const refused = result.answer.signers.some(entry => entry.status === 'misconfigured');
      const failure: KeySetFailure = refused
        ? { status: 'misconfigured', reason: 'signer_refused' }
        : { status: 'unavailable' };
      outcome = { status: 'failed', startedAt, failure };
    }
  } else {
    outcome = { status: 'failed', startedAt, failure: result };
  }
  if (state.read.status === 'reading' && state.read.startedAt === startedAt) state.read = outcome;
}

/**
 * Waits, without sharing a promise, while a read runs, until `deadline`. A read that replaces a
 * hung one keeps the wait going, so a waiter takes the newer read's result.
 */
async function waitForReads(state: FeedIsolate, deadline: number): Promise<void> {
  while (state.read.status === 'reading' && Date.now() < deadline) {
    await scheduler.wait(WAIT_STEP_MS);
  }
}

/** The set held at `now`, rebuilt without any object whose hold has ended. */
function servedFor(state: FeedIsolate, now: number): ServedSet | null {
  if (state.served === null || now - state.served.oldestReadAt < UTS_SIGNER_KEYS_HOLD_MS) {
    return state.served;
  }
  const live = (held: ReadonlyArray<HeldSigner | null>) =>
    held.map(entry =>
      entry !== null && now - entry.readAt < UTS_SIGNER_KEYS_HOLD_MS ? entry : null
    );
  state.signers = live(state.signers);
  state.feeds = live(state.feeds);
  state.served = servedSet(state, now);
  return state.served;
}

function isolateFor(environment: UtsEnvironment): FeedIsolate {
  if (isolate === null || isolate.environment !== environment) {
    isolate = {
      environment,
      signers: Array.from({ length: UTS_SIGNER_COUNT }, () => null),
      feeds: Array.from({ length: UTS_FEED_COUNT }, () => null),
      served: null,
      read: { status: 'idle' },
    };
  }
  return isolate;
}

function okRead(set: ServedSet, now: number): KeySetRead {
  return {
    status: 'ok',
    body: set.body,
    ageMs: Math.max(0, now - set.newestReadAt),
    oldestAgeMs: Math.max(0, now - set.oldestReadAt),
  };
}

/**
 * The key set for one request. While its newest keys are within the fresh window the held set
 * answers at once. After it, the first request (at most one per read guard) starts one read
 * (`ctx.waitUntil`) and serves the held set while its newest keys are under
 * `KEY_SET_MAX_SERVED_AGE_MS`; an older or missing set waits for the read. Any failed read leaves
 * the held keys serving, each signer's for up to 24 hours after its last good read.
 */
export async function serveKeySet(
  mint: SignerKeysBinding,
  environment: UtsEnvironment,
  ctx: ExecutionContext
): Promise<KeySetRead> {
  const state = isolateFor(environment);
  const now = Date.now();
  const copy = servedFor(state, now);
  const age = copy === null ? Number.POSITIVE_INFINITY : now - copy.newestReadAt;
  if (copy !== null && age < KEY_SET_FRESH_MS) return okRead(copy, now);
  if (state.read.status === 'idle' || now - state.read.startedAt >= KEY_SET_READ_GUARD_MS) {
    state.read = { status: 'reading', startedAt: now };
    const pending = runRead(state, mint, now);
    ctx.waitUntil(pending);
    if (copy !== null && age < KEY_SET_MAX_SERVED_AGE_MS) return okRead(copy, now);
    await pending;
  } else if (state.read.status === 'reading' && age >= KEY_SET_MAX_SERVED_AGE_MS) {
    await waitForReads(state, now + KEY_SET_READ_GUARD_MS);
  }
  const at = Date.now();
  const after = servedFor(state, at);
  if (after !== null) return okRead(after, at);
  return state.read.status === 'failed' ? state.read.failure : { status: 'unavailable' };
}

/** Test seam: drops this isolate's copy and read state, as a new isolate starts. */
export function resetIsolate(): void {
  isolate = null;
}

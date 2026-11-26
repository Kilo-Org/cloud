import {
  SignerKeysAnswerSchema,
  UTS_ENDPOINTS,
  UTS_SIGNER_COUNT,
  UTS_SIGNER_KEYS_HOLD_MS,
  UTS_SIGNER_KEYS_PATH,
  type SignerKeysAnswer,
  type UtsEnvironment,
  type UtsJwks,
  type UtsPublicJwk,
} from '@kilocode/uts-contracts';

/**
 * A set whose newest signer keys were read from their signer objects less than this long ago
 * serves with no new read. Past it, the first request starts one read in the background. A
 * response whose oldest keys are younger than this carries no `Age`.
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
 * Worker at most one read per 10 seconds. A read gives up after this long (its fetch is aborted),
 * and a request waits at most this long for reads other requests started.
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
   * A deploy error: the mint Worker does not answer this caller (`refused`), a signer object
   * refused to load and no other signer has keys (`signer_refused`), or the answer is not a valid
   * signer-keys answer (`invalid_answer`).
   */
  | { status: 'misconfigured'; reason: 'refused' | 'signer_refused' | 'invalid_answer' };

/** `ageMs`: how long ago the oldest keys in `body` were read from their signer object. */
export type KeySetRead = { status: 'ok'; body: string; ageMs: number } | KeySetFailure;

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
 * a read another request started polls `read` instead. Each signer's keys are held separately,
 * with the time they were read from their signer object, so one failing signer leaves the others
 * current. One state per environment, so no environment is served another's keys.
 */
type FeedIsolate = {
  environment: UtsEnvironment;
  signers: ReadonlyArray<HeldSigner | null>;
  served: ServedSet | null;
  read: ReadState;
};

let isolate: FeedIsolate | null = null;

type MintRead =
  | { status: 'answered'; answer: SignerKeysAnswer; receivedAt: number }
  | KeySetFailure;

/** The JSON value of `text`, or undefined when it is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Reads every signer's keys from the mint Worker's internal route, through the service binding to
 * its default entrypoint. The fetch, body included, is aborted after the read guard, so a hung read
 * is a failed read. The revocation-feed slice adds its two feed keys to the same `keys` array under
 * their own prefix.
 */
async function readFromMint(mint: Fetcher, environment: UtsEnvironment): Promise<MintRead> {
  let response: Response;
  let text: string;
  try {
    response = await mint.fetch(`${UTS_ENDPOINTS[environment].issuer}${UTS_SIGNER_KEYS_PATH}`, {
      signal: AbortSignal.timeout(KEY_SET_READ_GUARD_MS),
    });
    text = await response.text();
  } catch (error) {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.failed', error: String(error) }));
    return { status: 'unavailable' };
  }
  if (response.status === 404) {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.refused' }));
    return { status: 'misconfigured', reason: 'refused' };
  }
  const parsed = SignerKeysAnswerSchema.safeParse(parseJson(text));
  if (!parsed.success) {
    console.error(
      JSON.stringify({ event: 'uts_feed.signer_keys.invalid_answer', status: response.status })
    );
    // A platform error page in place of the route's JSON is a failed call, not a wrong answer.
    return response.status >= 500
      ? { status: 'unavailable' }
      : { status: 'misconfigured', reason: 'invalid_answer' };
  }
  const failed = parsed.data.signers.filter(entry => entry.status !== 'ok');
  if (failed.length > 0) {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.signers_failed', failed }));
  }
  return { status: 'answered', answer: parsed.data, receivedAt: Date.now() };
}

/**
 * The set to serve from `signers` at `now`: the keys of every signer read under 24 hours ago, in
 * signer order. A `kid` names its signer, and each signer's keys come from one validated answer,
 * so no `kid` repeats. A signer past the hold drops out and its tokens fail verification.
 */
function servedSet(signers: ReadonlyArray<HeldSigner | null>, now: number): ServedSet | null {
  const live: HeldSigner[] = [];
  const missing: number[] = [];
  for (const [signer, entry] of signers.entries()) {
    if (entry !== null && now - entry.readAt < UTS_SIGNER_KEYS_HOLD_MS) live.push(entry);
    else missing.push(signer);
  }
  if (missing.length > 0) {
    console.error(JSON.stringify({ event: 'uts_feed.key_set.signers_missing', missing }));
  }
  if (live.length === 0) return null;
  const readTimes = live.map(entry => entry.readAt);
  return {
    body: JSON.stringify({ keys: live.flatMap(entry => entry.keys) } satisfies UtsJwks),
    oldestReadAt: Math.min(...readTimes),
    newestReadAt: Math.max(...readTimes),
  };
}

/**
 * Takes each signer's keys from the answer when they were read later than the keys held for it.
 * A read time later than the answer's arrival, from a clock ahead of this one, counts as the
 * arrival, so no keys can outlive their hold.
 */
function merge(
  current: ReadonlyArray<HeldSigner | null>,
  answer: SignerKeysAnswer,
  receivedAt: number
): Array<HeldSigner | null> {
  const signers = [...current];
  for (const entry of answer.signers) {
    if (entry.status !== 'ok') continue;
    const readAt = Math.min(entry.readAt, receivedAt);
    const previous = signers[entry.signer] ?? null;
    if (previous === null || previous.readAt < readAt) {
      signers[entry.signer] = { keys: entry.keys, readAt };
    }
  }
  return signers;
}

/**
 * Runs one read and records its outcome. Keys newer than those held replace them signer by
 * signer, so a read that finishes late changes nothing a newer read brought.
 */
async function runRead(state: FeedIsolate, mint: Fetcher, startedAt: number): Promise<void> {
  const result = await readFromMint(mint, state.environment);
  let outcome: ReadState;
  if (result.status === 'answered') {
    state.signers = merge(state.signers, result.answer, result.receivedAt);
    state.served = servedSet(state.signers, Date.now());
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

/** The set held at `now`, rebuilt without any signer whose hold has ended. */
function servedFor(state: FeedIsolate, now: number): ServedSet | null {
  if (state.served === null || now - state.served.oldestReadAt < UTS_SIGNER_KEYS_HOLD_MS) {
    return state.served;
  }
  state.signers = state.signers.map(entry =>
    entry !== null && now - entry.readAt < UTS_SIGNER_KEYS_HOLD_MS ? entry : null
  );
  state.served = servedSet(state.signers, now);
  return state.served;
}

function isolateFor(environment: UtsEnvironment): FeedIsolate {
  if (isolate === null || isolate.environment !== environment) {
    isolate = {
      environment,
      signers: Array.from({ length: UTS_SIGNER_COUNT }, () => null),
      served: null,
      read: { status: 'idle' },
    };
  }
  return isolate;
}

function okRead(set: ServedSet, now: number): KeySetRead {
  return { status: 'ok', body: set.body, ageMs: Math.max(0, now - set.oldestReadAt) };
}

/**
 * The key set for one request. While its newest keys are within the fresh window the held set
 * answers at once. After it, the first request (at most one per read guard) starts one read
 * (`ctx.waitUntil`) and serves the held set while its newest keys are under
 * `KEY_SET_MAX_SERVED_AGE_MS`; an older or missing set waits for the read. Any failed read leaves
 * the held keys serving, each signer's for up to 24 hours after its last good read.
 */
export async function serveKeySet(
  mint: Fetcher,
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

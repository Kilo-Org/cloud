import {
  SignerKeysResultSchema,
  UTS_ENDPOINTS,
  UTS_SIGNER_KEYS_PATH,
  UtsJwksSchema,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';

/** An isolate serves the key set it holds without a new read for this long after that read. */
export const KEY_SET_FRESH_MS = 10 * 1000;

/**
 * The oldest key set a healthy feed Worker serves: past the fresh window, a request starts one
 * background read and still serves the held set, until the set is this old; after that, a request
 * waits for the read. A signer key change therefore reaches the key-set response within this time,
 * and reaches a verifier within this plus the verifier's 5-minute `max-age` (design 5.6, 5.7).
 */
export const KEY_SET_MAX_SERVED_AGE_MS = 15 * 1000;

/**
 * While reads fail, an isolate keeps serving the set it holds for up to 24 hours, the verifier's
 * own `stale-if-error` limit (design 7). It answers 503 only when it holds nothing usable.
 */
export const KEY_SET_HOLD_MS = 24 * 60 * 60 * 1000;

/**
 * A read in flight or a failed read blocks the next read for this long, so a failing signer costs
 * the mint Worker at most one read per isolate per 10 seconds, and a hung read is replaced after
 * it. It is also how long a request waits for a read another request started.
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
  /** The read failed or timed out; a later read can succeed. */
  | { status: 'unavailable' }
  /**
   * A deploy error: the mint Worker does not answer this caller (`refused`), a signer object
   * refused to load (`signer_refused`), or the answer is not a valid key set (`invalid_answer`).
   */
  | { status: 'misconfigured'; reason: 'refused' | 'signer_refused' | 'invalid_answer' };

export type KeySetRead = { status: 'ok'; body: string } | KeySetFailure;

/**
 * Isolate state, plain data only: a pending promise is never shared between requests, because
 * awaiting another request's I/O can hang once that request ends (design 7). A request that needs
 * a read another request started polls `read` instead.
 */
let held: { environment: UtsEnvironment; body: string; readAt: number } | null = null;

type ReadState =
  | { status: 'idle' }
  | { status: 'reading'; startedAt: number }
  | { status: 'failed'; startedAt: number; failure: KeySetFailure };

let read: ReadState = { status: 'idle' };

/**
 * Reads every signer's public keys from the mint Worker's internal route, through the service
 * binding to its default entrypoint, and serializes the key set. The revocation-feed slice adds
 * its two feed keys to the same `keys` array; `UtsJwksSchema` rejects a duplicate `kid` across both.
 */
async function readFromMint(mint: Fetcher, environment: UtsEnvironment): Promise<KeySetRead> {
  let response: Response;
  try {
    response = await mint.fetch(`${UTS_ENDPOINTS[environment].issuer}${UTS_SIGNER_KEYS_PATH}`);
  } catch (error) {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.failed', error: String(error) }));
    return { status: 'unavailable' };
  }
  if (response.status === 404) {
    console.error(JSON.stringify({ event: 'uts_feed.signer_keys.refused' }));
    return { status: 'misconfigured', reason: 'refused' };
  }
  const answer: unknown = await response.json().catch(() => undefined);
  const parsed = SignerKeysResultSchema.safeParse(answer);
  if (!parsed.success) {
    console.error(
      JSON.stringify({ event: 'uts_feed.signer_keys.invalid_answer', status: response.status })
    );
    // A platform error page in place of the route's JSON is a failed call, not a wrong answer.
    return response.status >= 500
      ? { status: 'unavailable' }
      : { status: 'misconfigured', reason: 'invalid_answer' };
  }
  switch (parsed.data.status) {
    case 'unavailable':
      console.error(JSON.stringify({ event: 'uts_feed.signer_keys.unavailable' }));
      return { status: 'unavailable' };
    case 'misconfigured':
      console.error(JSON.stringify({ event: 'uts_feed.signer_keys.signer_refused' }));
      return { status: 'misconfigured', reason: 'signer_refused' };
    case 'ok': {
      const jwks = UtsJwksSchema.safeParse({
        keys: parsed.data.signers.flatMap(entry => entry.keys),
      });
      if (!jwks.success) {
        console.error(JSON.stringify({ event: 'uts_feed.signer_keys.duplicate_kid' }));
        return { status: 'misconfigured', reason: 'invalid_answer' };
      }
      return { status: 'ok', body: JSON.stringify(jwks.data) };
    }
  }
}

/**
 * Runs one read and records its outcome. The held set is stamped with the time the read started,
 * so every window counts from before the read; a read that a newer one replaced changes nothing.
 */
async function runRead(
  mint: Fetcher,
  environment: UtsEnvironment,
  startedAt: number
): Promise<void> {
  const result = await readFromMint(mint, environment);
  if (result.status === 'ok') {
    const current = held;
    if (current === null || current.environment !== environment || current.readAt < startedAt) {
      held = { environment, body: result.body, readAt: startedAt };
    }
  }
  if (read.status === 'reading' && read.startedAt === startedAt) {
    read =
      result.status === 'ok'
        ? { status: 'idle' }
        : { status: 'failed', startedAt, failure: result };
  }
}

/** Waits, without sharing its promise, until the read that started at `startedAt` settles. */
async function waitForRead(startedAt: number): Promise<void> {
  while (
    read.status === 'reading' &&
    read.startedAt === startedAt &&
    Date.now() - startedAt < KEY_SET_READ_GUARD_MS
  ) {
    await scheduler.wait(WAIT_STEP_MS);
  }
}

/** The held set for `environment`, while it is within the 24-hour hold at `at`. */
function heldFor(environment: UtsEnvironment, at: number) {
  return held !== null && held.environment === environment && at - held.readAt < KEY_SET_HOLD_MS
    ? held
    : null;
}

/**
 * The key set for one request. Within the fresh window the held set answers at once. After it,
 * the first request starts one read (`ctx.waitUntil`) and serves the held set while it is under
 * `KEY_SET_MAX_SERVED_AGE_MS`; an older or missing set waits for the read. A failed read leaves
 * the held set serving for up to 24 hours.
 */
export async function serveKeySet(
  mint: Fetcher,
  environment: UtsEnvironment,
  ctx: ExecutionContext
): Promise<KeySetRead> {
  const now = Date.now();
  const copy = heldFor(environment, now);
  const age = copy === null ? Number.POSITIVE_INFINITY : now - copy.readAt;
  if (copy !== null && age < KEY_SET_FRESH_MS) return { status: 'ok', body: copy.body };
  if (read.status === 'idle' || now - read.startedAt >= KEY_SET_READ_GUARD_MS) {
    read = { status: 'reading', startedAt: now };
    const pending = runRead(mint, environment, now);
    ctx.waitUntil(pending);
    if (copy !== null && age < KEY_SET_MAX_SERVED_AGE_MS) return { status: 'ok', body: copy.body };
    await pending;
  } else if (read.status === 'reading' && age >= KEY_SET_MAX_SERVED_AGE_MS) {
    await waitForRead(read.startedAt);
  }
  const after = heldFor(environment, Date.now());
  if (after !== null) return { status: 'ok', body: after.body };
  return read.status === 'failed' ? read.failure : { status: 'unavailable' };
}

/** Test seam: drops this isolate's copy and read state, as a new isolate starts. */
export function resetIsolate(): void {
  held = null;
  read = { status: 'idle' };
}

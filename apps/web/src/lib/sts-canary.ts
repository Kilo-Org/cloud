import {
  AccessTokenClaimsSchema,
  STS_CANARY_HELD_STORE_TIMEOUT_MS,
  STS_CANARY_RUN_HEADER,
  STS_CANARY_VERIFY_CALL_TIMEOUT_MS,
  STS_DENIED_PROBE,
  STS_DENIED_PROBE_REASON,
  StsCanaryRunIdSchema,
  TOKEN_CLOCK_SKEW_SECONDS,
  USAGE_INGEST_CANARY_TOKEN,
  WEB_CANARY_TOKEN,
  stsCanaryDetail,
  stsCanaryPassed,
  type StsCanaryCheck,
  type StsCanaryReport,
} from '@kilocode/sts-contracts';
import { ServiceTokenError, type ServiceTokens } from '@kilocode/service-token-client';
import { failureResponse, type Verifier } from '@kilocode/verify';
import { z } from 'zod';

/**
 * The web side of the STS canary (decision D6c). usage-ingest calls it every 5 minutes with a
 * `web:sts.canary` token; it verifies that token, mints `usage-ingest:sts.canary` with the
 * function's own Vercel identity, presents it to usage-ingest, presents three tokens that
 * usage-ingest must refuse, and asks STS for the reserved denied probe `canary:denied-probe`,
 * which no policy can grant. It answers a report of every check and never a token.
 */
export type StsCanaryDeps = {
  /** Verifies `web:sts.canary` STS tokens; one per instance. */
  verifier: Verifier<false>;
  /** The HTTP service-token client with the Vercel identity; one per instance. */
  tokens: ServiceTokens;
  /**
   * A new HTTP client with the same Vercel identity, made for each run's denied mint. A client
   * answers a denial from memory for `DENIED_RECHECK_MS`, so a shared one could skip STS on a run
   * within a minute of the last; a new one asks STS every run and leaves no state behind.
   */
  newTokens: () => ServiceTokens;
  /** usage-ingest's `POST /sts-canary/verify`. */
  verifyUrl: string;
  /**
   * Where the route keeps its earlier `usage-ingest` tokens between runs: the Vercel Runtime
   * Cache, shared by every instance of the deployment, so the expired-token check does not depend
   * on two runs reaching one instance. `key` is null on Vercel without a deployment id; the check
   * then fails rather than share one entry across deployments.
   */
  held: { store: HeldTokenStore; key: string | null };
  waitUntil: (promise: Promise<unknown>) => void;
  fetch?: typeof fetch;
  now?: () => number;
};

/** The part of the Vercel Runtime Cache (`getCache` of `@vercel/functions`) the route uses. */
export type HeldTokenStore = {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown, options: { ttl: number }): Promise<void>;
};

/**
 * How long the held tokens live in the store: a little over two 5-minute runs, so the token a run
 * keeps is still there two runs later, when it is past `exp` (300 s) plus the 60 s skew.
 */
export const STS_CANARY_HELD_TTL_SECONDS = 15 * 60;
/**
 * Tokens kept, oldest first. Each run adds its own, so with two the oldest is past `exp` plus the
 * skew on every run from the third on: a token is two runs (600 s) old when it is presented.
 */
const HELD_TOKENS_MAX = 2;

const HeldTokensSchema = z
  .array(z.strictObject({ token: z.string().min(1), exp: z.number().int().nonnegative() }))
  .max(HELD_TOKENS_MAX);
type HeldToken = z.infer<typeof HeldTokensSchema>[number];

const ExpClaimSchema = AccessTokenClaimsSchema.pick({ exp: true });
const HeldClaimsSchema = AccessTokenClaimsSchema.pick({ exp: true, aud: true, scope: true });

/** The claims of a token, read without verifying it. */
function payloadOf(token: string): unknown {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** The `exp` of a token STS issued to this instance, read without verifying it. */
function expOf(token: string): number | null {
  const parsed = ExpClaimSchema.safeParse(payloadOf(token));
  return parsed.success ? parsed.data.exp : null;
}

/**
 * One Runtime Cache call, bounded by `STS_CANARY_HELD_STORE_TIMEOUT_MS`: `late` when it has not
 * settled in time. A rejection still rejects.
 */
async function withinStoreTimeout<T>(operation: () => Promise<T>): Promise<{ value: T } | 'late'> {
  const late = Promise.withResolvers<'late'>();
  const handle = setTimeout(() => late.resolve('late'), STS_CANARY_HELD_STORE_TIMEOUT_MS);
  try {
    return await Promise.race([operation().then(value => ({ value })), late.promise]);
  } finally {
    clearTimeout(handle);
  }
}

function heldFailure(detail: string): StsCanaryCheck {
  return { result: 'failed', status: null, detail };
}
const HELD_UNREADABLE = heldFailure('could not read the held tokens');
const HELD_UNVERIFIABLE = heldFailure('could not verify the held tokens');
const HELD_NOT_GENUINE = heldFailure('held token not genuine');
const HELD_UNKEPT = heldFailure('could not keep the token for a later run');
const HELD_NO_DEPLOYMENT = heldFailure('no deployment id to keep the held tokens under');

/** The deployment's held tokens, read and checked; or why the expired-token check failed. */
type HeldLoad =
  | { key: string; held: HeldToken[]; dropped: boolean; failure: null }
  | { failure: StsCanaryCheck };

/** A mint failure as a check's `detail`, without a token. */
function mintFailure(error: unknown): string {
  return stsCanaryDetail(
    error instanceof ServiceTokenError
      ? `mint ${error.reason}: ${error.deniedReason ?? `retry in ${error.retryAfterSeconds} s`}`
      : 'mint failed'
  );
}

/**
 * `sts_canary` lines are the canary's paging signal (services/usage-ingest README, "STS canary"):
 * one report per run from a caller that holds a `web:sts.canary` token. Anyone can call the route,
 * so a refused request logs `sts_canary_refused` instead, which no monitor pages on.
 */
function log(
  level: 'info' | 'warn',
  event: 'sts_canary' | 'sts_canary_refused',
  fields: Record<string, unknown>
): void {
  console[level](JSON.stringify({ event, ...fields }));
}

export function createStsCanaryHandler(
  deps: StsCanaryDeps
): (request: Request) => Promise<Response> {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  /** A throwaway key STS never held, made once per instance; it signs the forged token. */
  let forgeryKey: CryptoKey | null = null;
  /**
   * Whether a held token is one STS signed for this environment's usage-ingest canary scope, with
   * the `exp` it was held under. The route's verifier accepts audience `web` only, and checks the
   * signature, issuer and environment before the token's time and audience, so a held token STS
   * signed ends in `expired` (past `exp` plus the skew) or `audience` (not yet), never `ok`; any
   * other failure is a planted, forged or foreign entry. A key set it cannot reach is
   * `unavailable`.
   */
  async function genuineness(entry: HeldToken): Promise<'genuine' | 'not_genuine' | 'unavailable'> {
    const claims = HeldClaimsSchema.safeParse(payloadOf(entry.token));
    if (
      !claims.success ||
      claims.data.exp !== entry.exp ||
      claims.data.aud !== USAGE_INGEST_CANARY_TOKEN.audience ||
      claims.data.scope !== USAGE_INGEST_CANARY_TOKEN.scope
    ) {
      return 'not_genuine';
    }
    const verified = await deps.verifier.verify(
      `Bearer ${entry.token}`,
      { issuer: 'sts', scope: WEB_CANARY_TOKEN.scope },
      { waitUntil: deps.waitUntil }
    );
    if (verified.ok) return 'not_genuine';
    if (verified.reason === 'expired' || verified.reason === 'audience') return 'genuine';
    return verified.status === 503 ? 'unavailable' : 'not_genuine';
  }

  /**
   * Reads the deployment's held tokens and drops every entry that is not genuine. Runs alongside
   * the route's own mint: its 2 s read and any key-set fetch end within that 30 s attempt.
   */
  async function loadHeld(): Promise<HeldLoad> {
    const key = deps.held.key;
    if (key === null) return { failure: HELD_NO_DEPLOYMENT };
    let stored: unknown;
    try {
      const read = await withinStoreTimeout(async () => await deps.held.store.get(key));
      if (read === 'late') return { failure: HELD_UNREADABLE };
      stored = read.value;
    } catch {
      return { failure: HELD_UNREADABLE };
    }
    if (stored === undefined || stored === null) {
      return { key, held: [], dropped: false, failure: null };
    }
    const parsed = HeldTokensSchema.safeParse(stored);
    if (!parsed.success) return { key, held: [], dropped: true, failure: null };
    const held: HeldToken[] = [];
    for (const entry of parsed.data) {
      const verdict = await genuineness(entry);
      if (verdict === 'unavailable') return { failure: HELD_UNVERIFIABLE };
      if (verdict === 'genuine') held.push(entry);
    }
    return { key, held, dropped: held.length !== parsed.data.length, failure: null };
  }

  /**
   * The expired-token check over the deployment's held tokens (`deps.held`). The oldest genuine
   * token past `exp` plus the verifier's skew is presented, expecting 401; every such token then
   * leaves the store, and `verified`, this run's own token once usage-ingest accepted it, joins
   * it. `skipped` only while the store holds no token that old (a deployment's first two runs,
   * runs less than about 360 s apart, or after runs stopped for longer than the store keeps
   * them). An entry that is not genuine is dropped and fails the check (`held token not
   * genuine`), and so does a store that cannot be read or written in 2 s: the next runs would
   * otherwise skip the check unnoticed. A failed presentation is reported even when the write
   * fails too.
   */
  async function checkExpired(
    load: HeldLoad,
    verified: string | null,
    run: string
  ): Promise<StsCanaryCheck | 'skipped'> {
    if (load.failure !== null) return load.failure;
    const { key, held, dropped } = load;
    const cutoff = now() / 1000 - TOKEN_CLOCK_SKEW_SECONDS;
    const [due] = held.filter(entry => entry.exp < cutoff);
    const presented = due === undefined ? 'skipped' : check(await present(due.token, run), 401);
    const expired = dropped ? HELD_NOT_GENUINE : presented;

    const kept = held.filter(entry => entry.exp >= cutoff);
    const exp = verified === null ? null : expOf(verified);
    if (verified !== null && exp !== null && !kept.some(entry => entry.token === verified)) {
      kept.push({ token: verified, exp });
    }
    const next = kept.slice(-HELD_TOKENS_MAX);
    const unchanged =
      !dropped &&
      next.length === held.length &&
      next.every((entry, index) => entry === held[index]);
    if (unchanged) return expired;
    let written = false;
    try {
      const write = await withinStoreTimeout(
        async () => await deps.held.store.set(key, next, { ttl: STS_CANARY_HELD_TTL_SECONDS })
      );
      written = write !== 'late';
    } catch {
      written = false;
    }
    if (written || (expired !== 'skipped' && expired.result === 'failed')) return expired;
    return HELD_UNKEPT;
  }

  /**
   * The request carries an STS token, so a redirect is never followed: a 3xx is the status of a
   * failed check.
   */
  async function present(token: string, run: string): Promise<number | null> {
    try {
      const response = await fetchFn(deps.verifyUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, [STS_CANARY_RUN_HEADER]: run },
        redirect: 'manual',
        signal: AbortSignal.timeout(STS_CANARY_VERIFY_CALL_TIMEOUT_MS),
      });
      await response.body?.cancel();
      return response.status;
    } catch {
      return null;
    }
  }

  function check(status: number | null, expected: number): StsCanaryCheck {
    if (status === expected) return { result: 'ok', status };
    const redirected = status !== null && status >= 300 && status < 400;
    return {
      result: 'failed',
      status,
      detail: stsCanaryDetail(
        redirected ? `expected ${expected}, refused a redirect` : `expected ${expected}`
      ),
    };
  }

  /** The same header and claims, signed by a key STS never held. */
  async function forge(token: string): Promise<string> {
    if (forgeryKey === null) {
      const generated = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
        'sign',
        'verify',
      ]);
      if (!('privateKey' in generated)) throw new Error('Ed25519 generateKey returned no key pair');
      forgeryKey = generated.privateKey;
    }
    const [header = '', payload = ''] = token.split('.');
    const signature = await crypto.subtle.sign(
      'Ed25519',
      forgeryKey,
      new TextEncoder().encode(`${header}.${payload}`)
    );
    return `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`;
  }

  /**
   * Asks STS for `STS_DENIED_PROBE`, a reserved scope no policy can grant. `ok` only when STS
   * refused exactly that token with `STS_DENIED_PROBE_REASON`, a refusal of this identified
   * function that STS records as an `ai.kilo.sts.token.denied` row; an unavailable STS, an issued
   * token or any other reason fails. The client reports a per-token denial only when STS's answer
   * names the audience and scope it asked for. Never rejects.
   */
  async function deniedMint(): Promise<StsCanaryCheck> {
    try {
      await deps.newTokens().get(STS_DENIED_PROBE, { waitUntil: deps.waitUntil });
      return { result: 'failed', status: null, detail: 'STS issued the reserved denied probe' };
    } catch (error) {
      if (error instanceof ServiceTokenError && error.deniedReason === STS_DENIED_PROBE_REASON) {
        return { result: 'ok', status: null };
      }
      return { result: 'failed', status: null, detail: mintFailure(error) };
    }
  }

  return async request => {
    const inbound = await deps.verifier.verify(
      request,
      { issuer: 'sts', scope: WEB_CANARY_TOKEN.scope },
      { waitUntil: deps.waitUntil }
    );
    const presented = StsCanaryRunIdSchema.safeParse(request.headers.get(STS_CANARY_RUN_HEADER));
    const run = presented.success ? presented.data : crypto.randomUUID();
    if (!inbound.ok) {
      log('warn', 'sts_canary_refused', {
        run,
        status: inbound.status,
        error: inbound.error,
        reason: inbound.reason,
      });
      return failureResponse(inbound);
    }

    // Alongside the route's own mint, so its read and any key-set fetch add no time to the run.
    const heldLoad = loadHeld();
    let minted: { token: string } | { failure: StsCanaryCheck };
    try {
      minted = {
        token: await deps.tokens.get(USAGE_INGEST_CANARY_TOKEN, { waitUntil: deps.waitUntil }),
      };
    } catch (error) {
      minted = { failure: { result: 'failed', status: null, detail: mintFailure(error) } };
    }
    // After the route's own mint, so it never shares that STS call, and alongside the calls to
    // usage-ingest: its 30 s attempt ends within their 4 x 10 s.
    const stsDenied = deniedMint();
    const own = 'token' in minted ? minted.token : null;
    const outbound =
      'token' in minted ? check(await present(minted.token, run), 204) : minted.failure;

    const authorization = request.headers.get('authorization') ?? '';
    const wrongAudience = check(await present(authorization.replace(/^Bearer /, ''), run), 403);
    const forged: StsCanaryCheck =
      own === null
        ? { result: 'failed', status: null, detail: 'no token to forge from' }
        : check(await present(await forge(own), run), 401);

    // Only a token usage-ingest just accepted is kept for a later run.
    const expired = await checkExpired(await heldLoad, outbound.result === 'ok' ? own : null, run);

    const report: StsCanaryReport = {
      inbound: 'ok',
      outbound,
      negatives: { wrongAudience, forged, expired, stsDenied: await stsDenied },
    };
    // One line per run with every check and no token: the Vercel log drain carries it to Axiom,
    // where the canary's monitors read `outcome` (services/usage-ingest README, "STS canary").
    const passed = stsCanaryPassed(report);
    log(passed ? 'info' : 'warn', 'sts_canary', {
      run,
      step: 'report',
      outcome: passed ? 'succeeded' : 'failed',
      caller: inbound.caller.kind === 'service' ? inbound.caller.workload : inbound.caller.kind,
      ...report,
    });
    return Response.json(report, { headers: { 'cache-control': 'no-store' } });
  };
}

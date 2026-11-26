import {
  AccessTokenClaimsSchema,
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
   * on two runs reaching one instance.
   */
  held: { store: HeldTokenStore; key: string };
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

/** The `exp` of a token STS issued to this instance, read without verifying it. */
function expOf(token: string): number | null {
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = ExpClaimSchema.safeParse(claims);
  return parsed.success ? parsed.data.exp : null;
}

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
   * The expired-token check over the deployment's held tokens (`deps.held`). The oldest token past
   * `exp` plus the verifier's skew is presented, expecting 401; every such token then leaves the
   * store, and `verified`, this run's own token once usage-ingest accepted it, joins it. `skipped`
   * only while the store holds no token that old (the first two runs of a deployment, or after
   * runs stopped for longer than the store keeps them). A store that cannot be read or written
   * fails the check: the next runs would otherwise skip it unnoticed.
   */
  async function checkExpired(
    verified: string | null,
    run: string
  ): Promise<StsCanaryCheck | 'skipped'> {
    let held: HeldToken[];
    try {
      const stored = HeldTokensSchema.safeParse(await deps.held.store.get(deps.held.key));
      held = stored.success ? stored.data : [];
    } catch {
      return { result: 'failed', status: null, detail: 'could not read the held tokens' };
    }
    const cutoff = now() / 1000 - TOKEN_CLOCK_SKEW_SECONDS;
    const [due] = held.filter(entry => entry.exp < cutoff);
    const expired = due === undefined ? 'skipped' : check(await present(due.token, run), 401);

    const kept = held.filter(entry => entry.exp >= cutoff);
    const exp = verified === null ? null : expOf(verified);
    if (verified !== null && exp !== null && !kept.some(entry => entry.token === verified)) {
      kept.push({ token: verified, exp });
    }
    const next = kept.slice(-HELD_TOKENS_MAX);
    const unchanged =
      next.length === held.length && next.every((entry, index) => entry === held[index]);
    if (unchanged) return expired;
    try {
      await deps.held.store.set(deps.held.key, next, { ttl: STS_CANARY_HELD_TTL_SECONDS });
    } catch {
      return { result: 'failed', status: null, detail: 'could not keep the token for a later run' };
    }
    return expired;
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
    const expired = await checkExpired(outbound.result === 'ok' ? own : null, run);

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

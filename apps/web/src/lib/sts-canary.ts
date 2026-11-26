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
  waitUntil: (promise: Promise<unknown>) => void;
  fetch?: typeof fetch;
  now?: () => number;
};

type HeldToken = { token: string; exp: number };

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
   * An earlier `usage-ingest` token, plain data, kept until it is past `exp` plus the verifier's
   * skew; then presented once as the expired-token check and replaced by the current token.
   */
  let held: HeldToken | null = null;

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

    let expired: StsCanaryCheck | 'skipped' = 'skipped';
    if (held !== null && now() / 1000 > held.exp + TOKEN_CLOCK_SKEW_SECONDS) {
      expired = check(await present(held.token, run), 401);
      held = null;
    }
    if (held === null && own !== null) {
      const exp = expOf(own);
      if (exp !== null) held = { token: own, exp };
    }

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

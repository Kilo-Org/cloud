import {
  STS_CANARY_RUN_HEADER,
  StsCanaryRunIdSchema,
  TOKEN_CLOCK_SKEW_SECONDS,
  USAGE_INGEST_CANARY_TOKEN,
  WEB_CANARY_TOKEN,
  type StsCanaryCheck,
  type StsCanaryReport,
} from '@kilocode/sts-contracts';
import { ServiceTokenError, type ServiceTokens } from '@kilocode/service-token-client';
import { failureResponse, type Verifier } from '@kilocode/verify';

/**
 * The web side of the STS canary (decision D6c). usage-ingest calls it every 5 minutes with a
 * `web:sts.canary` token; it verifies that token, mints `usage-ingest:sts.canary` with the
 * function's own Vercel identity, presents it to usage-ingest, and presents three tokens that
 * usage-ingest must refuse. It answers a report of every check and never a token.
 */
export type StsCanaryDeps = {
  /** Verifies `web:sts.canary` STS tokens; one per instance. */
  verifier: Verifier<false>;
  /** The HTTP service-token client with the Vercel identity; one per instance. */
  tokens: ServiceTokens;
  /** usage-ingest's `POST /sts-canary/verify`. */
  verifyUrl: string;
  waitUntil: (promise: Promise<unknown>) => void;
  fetch?: typeof fetch;
  now?: () => number;
};

/** Each call to usage-ingest; it answers from memory once its key set is warm. */
const VERIFY_CALL_TIMEOUT_MS = 10_000;

type HeldToken = { token: string; exp: number };

function base64urlJson(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

function expOf(token: string): number | null {
  try {
    const claims = base64urlJson(token.split('.')[1] ?? '');
    return typeof claims === 'object' && claims !== null && 'exp' in claims && typeof claims.exp === 'number'
      ? claims.exp
      : null;
  } catch {
    return null;
  }
}

function log(level: 'info' | 'warn', fields: Record<string, unknown>): void {
  console[level](JSON.stringify({ event: 'sts_canary', ...fields }));
}

export function createStsCanaryHandler(deps: StsCanaryDeps): (request: Request) => Promise<Response> {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? Date.now;
  /** A throwaway key STS never held, made once per instance; it signs the forged token. */
  let forgeryKey: CryptoKey | null = null;
  /**
   * An earlier `usage-ingest` token, plain data, kept until it is past `exp` plus the verifier's
   * skew; then presented once as the expired-token check and replaced by the current token.
   */
  let held: HeldToken | null = null;

  async function present(token: string, run: string): Promise<number | null> {
    try {
      const response = await fetchFn(deps.verifyUrl, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, [STS_CANARY_RUN_HEADER]: run },
        signal: AbortSignal.timeout(VERIFY_CALL_TIMEOUT_MS),
      });
      await response.body?.cancel();
      return response.status;
    } catch {
      return null;
    }
  }

  function check(status: number | null, expected: number): StsCanaryCheck {
    return status === expected
      ? { result: 'ok', status }
      : { result: 'failed', status, detail: `expected ${expected}` };
  }

  /** The same header and claims, signed by a key STS never held. */
  async function forge(token: string): Promise<string> {
    forgeryKey ??= ((await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair)
      .privateKey;
    const [header = '', payload = ''] = token.split('.');
    const signature = await crypto.subtle.sign(
      'Ed25519',
      forgeryKey,
      new TextEncoder().encode(`${header}.${payload}`)
    );
    return `${header}.${payload}.${Buffer.from(signature).toString('base64url')}`;
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
      log('warn', { run, step: 'inbound', status: inbound.status, error: inbound.error, reason: inbound.reason });
      return failureResponse(inbound);
    }

    let own: string | null = null;
    let outbound: StsCanaryCheck;
    try {
      own = await deps.tokens.get(USAGE_INGEST_CANARY_TOKEN, { waitUntil: deps.waitUntil });
      outbound = check(await present(own, run), 204);
    } catch (error) {
      const detail =
        error instanceof ServiceTokenError
          ? `mint ${error.reason}: ${error.deniedReason ?? `retry in ${error.retryAfterSeconds} s`}`
          : 'mint failed';
      outbound = { result: 'failed', status: null, detail };
    }

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
      negatives: { wrongAudience, forged, expired },
    };
    log('info', {
      run,
      caller: inbound.caller.kind === 'service' ? inbound.caller.workload : inbound.caller.kind,
      ...report,
    });
    return Response.json(report, { headers: { 'cache-control': 'no-store' } });
  };
}

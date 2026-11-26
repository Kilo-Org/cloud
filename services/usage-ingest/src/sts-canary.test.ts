import {
  STS_CANARY_ROUTE_MAX_DURATION_SECONDS,
  STS_CANARY_VERIFY_CALL_TIMEOUT_MS,
  STS_CANARY_VERIFY_CALLS_MAX,
  type MintRequest,
  type MintResult,
  type StsCanaryReport,
} from '@kilocode/sts-contracts';
import { HTTP_ATTEMPT_TIMEOUT_MS, type MintBinding } from '@kilocode/service-token-client';
import { JWKS_FETCH_TIMEOUT_MS } from '@kilocode/verify';
import { afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  handleStsCanaryVerify,
  runStsCanary,
  WEB_CALL_TIMEOUT_MS,
  type StsCanaryEnv,
} from './sts-canary';
import { serviceClaims, signToken, testSigner, type TestSigner } from './sts-canary.test-fixture';

const STS_URL = 'https://sts.kiloapps.io';
const WEB_URL = 'https://app.kilo.ai/api/internal/sts-canary';
const VERIFY_URL = 'https://usage-ingest.test/sts-canary/verify';

let signer: TestSigner;

beforeAll(async () => {
  signer = await testSigner();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function ingestClaims(overrides: Record<string, unknown> = {}) {
  return {
    ...serviceClaims({
      issuer: STS_URL,
      workload: 'web',
      audience: 'usage-ingest',
      scope: 'usage-ingest:sts.canary',
    }),
    ...overrides,
  };
}

/** Serves the stand-in key set at STS_URL; any other URL is answered by `other`. */
function stubFetch(
  other: (url: string, init?: RequestInit) => Response | Promise<Response> = () =>
    new Response('unexpected', { status: 599 })
) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (url === `${STS_URL}/.well-known/jwks.json`) return Response.json(signer.jwks);
      return await other(url, init);
    })
  );
  return calls;
}

async function verifyWith(token: string | null, method = 'POST') {
  const headers: Record<string, string> =
    token === null ? {} : { authorization: `Bearer ${token}` };
  return await handleStsCanaryVerify(new Request(VERIFY_URL, { method, headers }), { STS_URL });
}

describe('POST /sts-canary/verify', () => {
  it('answers 204 for a usage-ingest:sts.canary token from the configured STS', async () => {
    stubFetch();
    const response = await verifyWith(await signToken(signer, ingestClaims()));
    expect(response.status).toBe(204);
  });

  it('refuses per design section 7 and logs the refusal without the token', async () => {
    stubFetch();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const webToken = await signToken(
      signer,
      serviceClaims({
        issuer: STS_URL,
        workload: 'usage-ingest',
        audience: 'web',
        scope: 'web:sts.canary',
      })
    );
    const wrongAudience = await verifyWith(webToken);
    expect(wrongAudience.status).toBe(403);
    expect(await wrongAudience.json()).toMatchObject({ error: 'insufficient_scope' });

    const forger = await testSigner(signer.kid);
    const forged = await verifyWith(await signToken(forger, ingestClaims()));
    expect(forged.status).toBe(401);

    const past = Math.floor(Date.now() / 1000) - 3_600;
    const expired = await verifyWith(
      await signToken(signer, ingestClaims({ iat: past, exp: past + 300 }))
    );
    expect(expired.status).toBe(401);

    const missing = await verifyWith(null);
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('resource_metadata=');

    const logged = warn.mock.calls.map(([line]) => String(line)).join('\n');
    expect(logged).toContain('sts_canary_verify_refused');
    expect(logged).not.toContain(webToken);
  });

  it('answers 405 for another method and 503 without STS_URL', async () => {
    expect((await verifyWith(null, 'GET')).status).toBe(405);
    const unconfigured = await handleStsCanaryVerify(
      new Request(VERIFY_URL, { method: 'POST' }),
      {}
    );
    expect(unconfigured.status).toBe(503);
  });
});

const PASSING_REPORT: StsCanaryReport = {
  inbound: 'ok',
  outbound: { result: 'ok', status: 204 },
  negatives: {
    wrongAudience: { result: 'ok', status: 403 },
    forged: { result: 'ok', status: 401 },
    expired: 'skipped',
  },
};

function binding(answer: (request: MintRequest) => MintResult) {
  const mintTokens = vi.fn(async (request: MintRequest) => answer(request));
  return { mintTokens };
}

function issue(request: MintRequest): MintResult {
  return {
    status: 'ok',
    tokens: request.tokens.map(({ audience, scope }) => ({
      status: 'issued',
      audience,
      scope,
      token: 'minted.web.token',
      jti: 'jti-1',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
    })),
  };
}

const CONTROLLER = { cron: '*/5 * * * *', scheduledTime: Date.UTC(2026, 10, 26, 12, 0, 0) };

function context(): ExecutionContext {
  return {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
  } as unknown as ExecutionContext;
}

/** The `scheduled_job.completed` events the run logged. */
function events(info: MockInstance, error: MockInstance) {
  return [...info.mock.calls, ...error.mock.calls]
    .map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    .filter(event => event.event_name === 'scheduled_job.completed');
}

describe('scheduled STS canary', () => {
  it('does nothing unless STS_CANARY_ENABLED is exactly true', async () => {
    const calls = stubFetch();
    const sts = binding(issue);
    await runStsCanary(
      CONTROLLER,
      { STS: sts, STS_CANARY_ENABLED: 'false', WEB_STS_CANARY_URL: WEB_URL },
      context()
    );
    expect(sts.mintTokens).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('mints web:sts.canary, calls the web route and logs one succeeded event with each check', async () => {
    const calls = stubFetch(() => Response.json(PASSING_REPORT));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const sts = binding(issue);
    const env: StsCanaryEnv = {
      STS: sts,
      STS_CANARY_ENABLED: 'true',
      STS_URL,
      WEB_STS_CANARY_URL: WEB_URL,
      USAGE_WRITER_PROTECTION_BYPASS: 'bypass-value',
    };
    await runStsCanary(CONTROLLER, env, context());

    expect(sts.mintTokens).toHaveBeenCalledWith({
      tokens: [{ audience: 'web', scope: 'web:sts.canary' }],
    });
    const [web] = calls;
    expect(web.url).toBe(WEB_URL);
    const headers = new Headers(web.init?.headers);
    expect(headers.get('authorization')).toBe('Bearer minted.web.token');
    expect(headers.get('x-vercel-protection-bypass')).toBe('bypass-value');
    expect(headers.get('x-sts-canary-run')).toMatch(/^[0-9a-f-]{36}$/);

    const [event, ...rest] = events(info, error);
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      job_name: 'usage_ingest.sts_canary',
      environment: 'production',
      outcome: 'succeeded',
      run_id: headers.get('x-sts-canary-run'),
      mint_result: 'issued',
      web_status: 200,
      inbound_result: 'ok',
      outbound_result: 'ok',
      outbound_status: 204,
      negative_wrong_audience_status: 403,
      negative_forged_status: 401,
      negative_expired_result: 'skipped',
    });
    expect(JSON.stringify(event)).not.toContain('minted.web.token');
  });

  it('logs a failed event when a check fails, when the web route refuses, or when STS denies the mint', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = (sts: MintBinding): StsCanaryEnv => ({
      STS: sts,
      STS_CANARY_ENABLED: 'true',
      STS_URL,
      WEB_STS_CANARY_URL: WEB_URL,
    });

    // A detail echoing a credential stays out of this Worker's logs.
    const echoed = 'authorization echoed: minted.web.token';
    stubFetch(() =>
      Response.json({
        ...PASSING_REPORT,
        negatives: {
          ...PASSING_REPORT.negatives,
          forged: { result: 'failed', status: 204, detail: echoed },
        },
      })
    );
    await runStsCanary(CONTROLLER, env(binding(issue)), context());
    stubFetch(() => Response.json({ error: 'invalid_token' }, { status: 401 }));
    await runStsCanary(CONTROLLER, env(binding(issue)), context());
    await runStsCanary(
      CONTROLLER,
      env(
        binding(request => ({
          status: 'ok',
          tokens: request.tokens.map(({ audience, scope }) => ({
            status: 'denied',
            audience,
            scope,
            reason: 'scope_not_allowed',
          })),
        }))
      ),
      context()
    );

    expect(events(info, error)).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        exception_name: 'StsCanaryCheckFailed',
        negative_forged_result: 'failed',
      }),
      expect.objectContaining({
        outcome: 'failed',
        exception_name: 'StsCanaryWebRefused',
        web_status: 401,
      }),
      expect.objectContaining({
        outcome: 'failed',
        exception_name: 'ServiceTokenError',
        mint_result: 'denied',
        mint_detail: 'scope_not_allowed',
      }),
    ]);
    const [checkFailed] = events(info, error);
    expect(checkFailed).not.toHaveProperty('negative_forged_detail');
    expect(JSON.stringify(events(info, error))).not.toContain(echoed);
  });

  it('never follows a redirect from the web route: the call is manual and a 3xx fails the run', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = stubFetch((_url, init) =>
      init?.redirect === 'manual'
        ? new Response(null, { status: 307, headers: { location: 'https://elsewhere.test/' } })
        : Response.json(PASSING_REPORT)
    );
    await runStsCanary(
      CONTROLLER,
      {
        STS: binding(issue),
        STS_CANARY_ENABLED: 'true',
        STS_URL,
        WEB_STS_CANARY_URL: WEB_URL,
        USAGE_WRITER_PROTECTION_BYPASS: 'bypass-value',
      },
      context()
    );
    expect(calls.map(call => call.url)).toEqual([WEB_URL]);
    expect(events(info, error)).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        exception_name: 'StsCanaryWebRefused',
        web_status: 307,
      }),
    ]);
  });

  it('waits for the web route longer than its slowest run and less than its maxDuration', () => {
    const slowestRunMs =
      JWKS_FETCH_TIMEOUT_MS +
      HTTP_ATTEMPT_TIMEOUT_MS +
      STS_CANARY_VERIFY_CALLS_MAX * STS_CANARY_VERIFY_CALL_TIMEOUT_MS;
    expect(WEB_CALL_TIMEOUT_MS).toBeGreaterThan(slowestRunMs);
    expect(WEB_CALL_TIMEOUT_MS).toBeLessThan(STS_CANARY_ROUTE_MAX_DURATION_SECONDS * 1000);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey as JoseKey } from 'jose';
import type { ServiceTokens } from '@kilocode/service-token-client';
import { ServiceTokenError, createServiceTokens } from '@kilocode/service-token-client';
import { createVerifier, failureResponse } from '@kilocode/verify';
import {
  STS_CANARY_ROUTE_MAX_DURATION_SECONDS,
  type MintRequest,
  type MintResult,
  type StsCanaryReport,
} from '@kilocode/sts-contracts';
import { createStsCanaryHandler } from './sts-canary';

// The canary handler against a real verifier on both sides: the STS key set is a local key, the
// usage-ingest stand-in verifies with @kilocode/verify exactly as the Worker route does, and the
// token client is a fake that hands out tokens this test signs.

const STS = 'https://sts.test';
const KID = 'test-kid';
const ROUTE = 'https://app.test/api/internal/sts-canary';
const VERIFY_URL = 'https://usage-ingest.test/sts-canary/verify';
const RUN = '6f1c8f9e-4a43-4c6f-9f57-2f6d2b8c1a10';

let privateKey: JoseKey;
let jwks: { keys: unknown[] };

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'EdDSA' }] };
});

afterEach(() => {
  jest.useRealTimers();
});

async function stsToken(workload: string, audience: string, scope: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return await new SignJWT({ client_id: workload, req: workload, env: 'production', scope })
    .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt', kid: KID })
    .setIssuer(STS)
    .setSubject(`service:${workload}`)
    .setAudience(audience)
    .setJti(crypto.randomUUID())
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(privateKey);
}

function verifierFor(audience: string) {
  return createVerifier({
    audience,
    environment: 'production',
    resourceMetadataUrl: `https://${audience}.test/.well-known/oauth-protected-resource`,
    sts: { issuer: STS, jwks: async () => jwks },
  });
}

const waitUntil = (promise: Promise<unknown>) => void promise;

/** usage-ingest's verify route, in process. */
function usageIngest() {
  const verifier = verifierFor('usage-ingest');
  const presented: string[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization');
    presented.push(new Headers(init?.headers).get('x-sts-canary-run') ?? '');
    const result = await verifier.verify(
      authorization,
      { issuer: 'sts', scope: 'usage-ingest:sts.canary' },
      { waitUntil }
    );
    return result.ok ? new Response(null, { status: 204 }) : failureResponse(result);
  }) as typeof fetch;
  return { fetchFn, presented };
}

function fakeTokens(get: () => Promise<string>): ServiceTokens {
  return { get: jest.fn(get) };
}

/** What STS answers the `web` workload for the reserved probe: no policy lists the audience `canary`. */
const DENIED = {
  status: 'denied',
  audience: 'canary',
  scope: 'canary:denied-probe',
  reason: 'audience_not_allowed',
} as const;

function deniedTokens(): ServiceTokens {
  return fakeTokens(async () => {
    throw new ServiceTokenError(
      { reason: 'denied', deniedReason: DENIED.reason },
      { audience: DENIED.audience, scope: DENIED.scope }
    );
  });
}

function handler(
  tokens: ServiceTokens,
  fetchFn: typeof fetch,
  now?: () => number,
  newTokens: () => ServiceTokens = deniedTokens
) {
  return createStsCanaryHandler({
    verifier: verifierFor('web'),
    tokens,
    newTokens,
    verifyUrl: VERIFY_URL,
    waitUntil,
    fetch: fetchFn,
    now,
  });
}

async function call(run: (request: Request) => Promise<Response>, token: string | null) {
  const headers: Record<string, string> = { 'x-sts-canary-run': RUN };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return await run(new Request(ROUTE, { method: 'POST', headers }));
}

describe('STS canary route handler', () => {
  it('refuses a caller without a valid web:sts.canary token before doing anything else', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const { fetchFn, presented } = usageIngest();
    const tokens = fakeTokens(async () => 'unused');
    const run = handler(tokens, fetchFn);

    const missing = await call(run, null);
    expect(missing.status).toBe(401);
    const wrongScope = await call(
      run,
      await stsToken('web', 'usage-ingest', 'usage-ingest:sts.canary')
    );
    expect(wrongScope.status).toBe(403);
    expect(tokens.get).not.toHaveBeenCalled();
    expect(presented).toEqual([]);

    // A refusal is not a canary run: its line never carries the `sts_canary` event the monitors
    // page on.
    const lines = [...warn.mock.calls, ...info.mock.calls].map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>
    );
    expect(lines.map(line => line.event)).toEqual(['sts_canary_refused', 'sts_canary_refused']);
    expect(lines.map(line => line.status)).toEqual([401, 403]);
    warn.mockRestore();
    info.mockRestore();
  });

  it('verifies the caller, gets 204 for its own token and the refusals usage-ingest must answer', async () => {
    const { fetchFn, presented } = usageIngest();
    const own = await stsToken('web', 'usage-ingest', 'usage-ingest:sts.canary');
    const run = handler(
      fakeTokens(async () => own),
      fetchFn
    );

    const response = await call(run, await stsToken('usage-ingest', 'web', 'web:sts.canary'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      inbound: 'ok',
      outbound: { result: 'ok', status: 204 },
      negatives: {
        wrongAudience: { result: 'ok', status: 403 },
        forged: { result: 'ok', status: 401 },
        expired: 'skipped',
        stsDenied: { result: 'ok', status: null },
      },
    } satisfies StsCanaryReport);
    expect(body).not.toContain(own);
    expect(presented).toEqual([RUN, RUN, RUN]);
  });

  it('presents its earlier token once it is past exp plus the skew, and expects 401', async () => {
    jest.useFakeTimers({
      doNotFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'],
    });
    jest.setSystemTime(Date.UTC(2026, 10, 26, 12, 0, 0));
    const { fetchFn } = usageIngest();
    let current = await stsToken('web', 'usage-ingest', 'usage-ingest:sts.canary');
    const run = handler(
      fakeTokens(async () => current),
      fetchFn
    );

    await call(run, await stsToken('usage-ingest', 'web', 'web:sts.canary'));
    jest.setSystemTime(Date.UTC(2026, 10, 26, 12, 6, 30));
    current = await stsToken('web', 'usage-ingest', 'usage-ingest:sts.canary');
    const later = await call(run, await stsToken('usage-ingest', 'web', 'web:sts.canary'));
    const report = (await later.json()) as StsCanaryReport;
    expect(report.outbound).toEqual({ result: 'ok', status: 204 });
    expect(report.negatives.expired).toEqual({ result: 'ok', status: 401 });
  });

  it('reports a mint failure without a token and still checks the wrong audience', async () => {
    const { fetchFn } = usageIngest();
    const tokens = fakeTokens(async () => {
      throw new ServiceTokenError(
        { reason: 'denied', deniedReason: 'identity_rejected' },
        { audience: 'usage-ingest', scope: 'usage-ingest:sts.canary' }
      );
    });
    const response = await call(
      handler(tokens, fetchFn),
      await stsToken('usage-ingest', 'web', 'web:sts.canary')
    );
    const report = (await response.json()) as StsCanaryReport;
    expect(report.outbound).toMatchObject({ result: 'failed', status: null });
    expect(report.negatives.wrongAudience).toEqual({ result: 'ok', status: 403 });
    expect(report.negatives.forged).toMatchObject({ result: 'failed', status: null });
  });

  it('never follows a redirect from usage-ingest: every call is manual and a 3xx fails its check', async () => {
    const { fetchFn: verify } = usageIngest();
    const redirects: (RequestRedirect | undefined)[] = [];
    const fetchFn: typeof fetch = async (url, init) => {
      redirects.push(init?.redirect);
      // A host that redirects: followed, the token would reach the target, which verifies it.
      if (init?.redirect === 'manual') {
        return new Response(null, {
          status: 308,
          headers: { location: 'https://elsewhere.test/' },
        });
      }
      return await verify(url, init);
    };
    const own = await stsToken('web', 'usage-ingest', 'usage-ingest:sts.canary');
    const response = await call(
      handler(
        fakeTokens(async () => own),
        fetchFn
      ),
      await stsToken('usage-ingest', 'web', 'web:sts.canary')
    );
    const report = (await response.json()) as StsCanaryReport;
    expect(redirects).toEqual(['manual', 'manual', 'manual']);
    expect(report.outbound).toEqual({
      result: 'failed',
      status: 308,
      detail: 'expected 204, refused a redirect',
    });
    expect(report.negatives.wrongAudience).toMatchObject({ result: 'failed', status: 308 });
  });

  it('keeps the route maxDuration equal to the budget usage-ingest waits under', () => {
    const route = readFileSync(join(__dirname, '../app/api/internal/sts-canary/route.ts'), 'utf8');
    expect(route).toContain(`export const maxDuration = ${STS_CANARY_ROUTE_MAX_DURATION_SECONDS};`);
  });
});

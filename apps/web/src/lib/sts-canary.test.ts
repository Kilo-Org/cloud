import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
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
import { createStsCanaryHandler, type HeldTokenStore } from './sts-canary';

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
    sts: { issuer: STS, jwks: async () => ({ body: jwks, age: null, oldestAge: null }) },
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

/** The Vercel Runtime Cache, in process: entries expire after their `ttl`, on the system clock. */
function memoryStore() {
  const entries = new Map<string, { value: unknown; until: number }>();
  const writes: { key: string; ttl: number }[] = [];
  return {
    writes,
    entries,
    async get(key: string) {
      const entry = entries.get(key);
      return entry !== undefined && Date.now() < entry.until ? entry.value : undefined;
    },
    async set(key: string, value: unknown, options: { ttl: number }) {
      writes.push({ key, ttl: options.ttl });
      entries.set(key, { value: structuredClone(value), until: Date.now() + options.ttl * 1000 });
    },
  };
}

function handler(
  tokens: ServiceTokens,
  fetchFn: typeof fetch,
  now?: () => number,
  newTokens: () => ServiceTokens = deniedTokens,
  store: HeldTokenStore = memoryStore(),
  key: string | null = 'held:dpl_test'
) {
  return createStsCanaryHandler({
    verifier: verifierFor('web'),
    tokens,
    newTokens,
    verifyUrl: VERIFY_URL,
    held: { store, key },
    waitUntil,
    fetch: fetchFn,
    now,
  });
}

/**
 * STS over the real token client: the `web` workload gets `usage-ingest:sts.canary` and is refused
 * `canary:denied-probe` with `audience_not_allowed`, unless `answerDenied` says otherwise. Records
 * every call's requested tokens.
 */
function sts(
  answerDenied: (request: MintRequest) => MintResult = () => ({ status: 'ok', tokens: [DENIED] })
) {
  const calls: string[][] = [];
  const transport = async (request: MintRequest): Promise<MintResult> => {
    calls.push(request.tokens.map(({ audience, scope }) => `${audience} ${scope}`));
    if (request.tokens.some(({ audience }) => audience === 'canary')) return answerDenied(request);
    const token = await stsToken('web', 'usage-ingest', 'usage-ingest:sts.canary');
    return {
      status: 'ok',
      tokens: [
        {
          status: 'issued',
          audience: 'usage-ingest',
          scope: 'usage-ingest:sts.canary',
          token,
          jti: crypto.randomUUID(),
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        },
      ],
    };
  };
  const client = () => createServiceTokens(transport, { attemptTimeoutMs: 1_000 });
  return { calls, tokens: client(), newTokens: client };
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

  describe('expired-token check', () => {
    const at = (minutes: number, seconds = 0) => Date.UTC(2026, 10, 26, 12, minutes, seconds);

    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'nextTick', 'queueMicrotask'],
      });
    });

    /** One run on a fresh instance (a new handler) of the deployment that shares `store`. */
    async function runOnNewInstance(
      time: number,
      store: HeldTokenStore,
      options: { fetchFn?: typeof fetch; key?: string | null } = {}
    ): Promise<{ report: StsCanaryReport; own: string }> {
      jest.setSystemTime(time);
      const own = await stsToken('web', 'usage-ingest', 'usage-ingest:sts.canary');
      const response = await call(
        handler(
          fakeTokens(async () => own),
          options.fetchFn ?? usageIngest().fetchFn,
          undefined,
          deniedTokens,
          store,
          options.key === undefined ? 'held:dpl_test' : options.key
        ),
        await stsToken('usage-ingest', 'web', 'web:sts.canary')
      );
      return { report: (await response.json()) as StsCanaryReport, own };
    }

    /** A store that already holds `entries` under the test key. */
    async function storeHolding(entries: unknown) {
      const store = memoryStore();
      await store.set('held:dpl_test', entries, { ttl: 900 });
      return store;
    }

    const NOT_GENUINE = { result: 'failed', status: null, detail: 'held token not genuine' };

    it('presents a token past exp plus the skew on every run from the third, whatever instance serves it', async () => {
      const store = memoryStore();
      const runs = [];
      for (const minute of [0, 5, 10, 15]) runs.push(await runOnNewInstance(at(minute), store));

      expect(runs.map(({ report }) => report.negatives.expired)).toEqual([
        'skipped',
        'skipped',
        { result: 'ok', status: 401 },
        { result: 'ok', status: 401 },
      ]);
      // The store keeps the two latest tokens, for a little over two runs, under one key.
      expect(store.entries.get('held:dpl_test')?.value).toEqual([
        { token: runs[2].own, exp: Math.floor(at(10) / 1000) + 300 },
        { token: runs[3].own, exp: Math.floor(at(15) / 1000) + 300 },
      ]);
      expect(store.writes).toEqual(
        Array.from({ length: 4 }, () => ({ key: 'held:dpl_test', ttl: 900 }))
      );
      expect(JSON.stringify(runs.map(({ report }) => report))).not.toContain(runs[0].own);
    });

    it('never keeps a token usage-ingest did not accept', async () => {
      const store = memoryStore();
      const { fetchFn } = usageIngest();
      const down: typeof fetch = async () => new Response(null, { status: 503 });
      await runOnNewInstance(at(0), store, { fetchFn: down });
      await runOnNewInstance(at(5), store, { fetchFn });
      const third = await runOnNewInstance(at(10), store, { fetchFn });
      expect(third.report.negatives.expired).toBe('skipped');
      const fourth = await runOnNewInstance(at(15), store, { fetchFn });
      expect(fourth.report.negatives.expired).toEqual({ result: 'ok', status: 401 });
    });

    it('skips again only once the store dropped the held tokens, and fails when the store does', async () => {
      const store = memoryStore();
      await runOnNewInstance(at(0), store);
      // Past the 900 s the store keeps them: nothing old enough is left.
      const late = await runOnNewInstance(at(16), store);
      expect(late.report.negatives.expired).toBe('skipped');

      const broken: HeldTokenStore = {
        get: async () => {
          throw new Error('runtime cache unavailable');
        },
        set: async () => {},
      };
      const unread = await runOnNewInstance(at(20), broken);
      expect(unread.report.negatives.expired).toEqual({
        result: 'failed',
        status: null,
        detail: 'could not read the held tokens',
      });
      const unwritable: HeldTokenStore = {
        get: async () => undefined,
        set: async () => {
          throw new Error('runtime cache unavailable');
        },
      };
      const unkept = await runOnNewInstance(at(25), unwritable);
      expect(unkept.report.negatives.expired).toEqual({
        result: 'failed',
        status: null,
        detail: 'could not keep the token for a later run',
      });
    });

    it('fails on a planted entry and drops it', async () => {
      const store = await storeHolding([{ token: 'x', exp: 0 }]);
      const planted = await runOnNewInstance(at(10), store);
      expect(planted.report.negatives.expired).toEqual(NOT_GENUINE);
      expect(store.entries.get('held:dpl_test')?.value).toEqual([
        { token: planted.own, exp: Math.floor(at(10) / 1000) + 300 },
      ]);
      // Not an entry the store could hold at all.
      const garbage = await runOnNewInstance(at(15), await storeHolding({ token: 'x' }));
      expect(garbage.report.negatives.expired).toEqual(NOT_GENUINE);
    });

    it('fails on an entry whose claims STS never signed or that names another exp', async () => {
      jest.setSystemTime(at(0));
      const genuine = await stsToken('web', 'usage-ingest', 'usage-ingest:sts.canary');
      const exp = Math.floor(at(0) / 1000) + 300;
      const { privateKey: otherKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
      const [header = '', payload = ''] = genuine.split('.');
      const forged = await new SignJWT(
        JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>
      )
        .setProtectedHeader(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')))
        .sign(otherKey);

      const presented: string[] = [];
      const { fetchFn } = usageIngest();
      const recording: typeof fetch = async (url, init) => {
        presented.push(new Headers(init?.headers).get('authorization') ?? '');
        return await fetchFn(url, init);
      };
      const signature = await runOnNewInstance(
        at(10),
        await storeHolding([{ token: forged, exp }]),
        { fetchFn: recording }
      );
      expect(signature.report.negatives.expired).toEqual(NOT_GENUINE);
      // A token that is not genuine is never presented.
      expect(presented).not.toContain(`Bearer ${forged}`);

      const restamped = await runOnNewInstance(
        at(10),
        await storeHolding([{ token: genuine, exp: exp - 600 }])
      );
      expect(restamped.report.negatives.expired).toEqual(NOT_GENUINE);
    });

    it('fails when the store does not answer within 2 s', async () => {
      const hung: HeldTokenStore = {
        get: async () => await Promise.withResolvers<never>().promise,
        set: async () => {},
      };
      const started = Date.now();
      const slow = await runOnNewInstance(at(10), hung);
      expect(slow.report.negatives.expired).toEqual({
        result: 'failed',
        status: null,
        detail: 'could not read the held tokens',
      });
      expect(Date.now() - started).toBeLessThan(5_000);
    });

    it('reports a failed presentation over a failed write', async () => {
      jest.setSystemTime(at(0));
      const held = await stsToken('web', 'usage-ingest', 'usage-ingest:sts.canary');
      const stored = await storeHolding([{ token: held, exp: Math.floor(at(0) / 1000) + 300 }]);
      const { fetchFn } = usageIngest();
      // usage-ingest wrongly accepts the expired token, and the write after it fails.
      const accepting: typeof fetch = async (url, init) =>
        new Headers(init?.headers).get('authorization') === `Bearer ${held}`
          ? new Response(null, { status: 200 })
          : await fetchFn(url, init);
      const unwritable: HeldTokenStore = {
        get: async key => await stored.get(key),
        set: async () => {
          throw new Error('runtime cache unavailable');
        },
      };
      const run = await runOnNewInstance(at(10), unwritable, { fetchFn: accepting });
      expect(run.report.negatives.expired).toEqual({
        result: 'failed',
        status: 200,
        detail: 'expected 401',
      });
    });

    it('fails without a deployment id to keep the held tokens under', async () => {
      const store = memoryStore();
      const run = await runOnNewInstance(at(10), store, { key: null });
      expect(run.report.negatives.expired).toEqual({
        result: 'failed',
        status: null,
        detail: 'no deployment id to keep the held tokens under',
      });
      expect(store.writes).toEqual([]);
    });
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

  it('asks STS every run, in a call of its own, for the reserved probe and expects audience_not_allowed', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const { fetchFn } = usageIngest();
    const stub = sts();
    const run = handler(stub.tokens, fetchFn, undefined, stub.newTokens);
    const inbound = await stsToken('usage-ingest', 'web', 'web:sts.canary');

    // Two runs well within the client's 60 s denied state: each still reaches STS.
    const first = (await (await call(run, inbound)).json()) as StsCanaryReport;
    const second = (await (await call(run, inbound)).json()) as StsCanaryReport;

    for (const report of [first, second]) {
      expect(report.outbound).toEqual({ result: 'ok', status: 204 });
      expect(report.negatives.stsDenied).toEqual({ result: 'ok', status: null });
    }
    // The allowed token is minted once and then served from memory; the denial never joins it.
    expect(stub.calls).toEqual([
      ['usage-ingest usage-ingest:sts.canary'],
      ['canary canary:denied-probe'],
      ['canary canary:denied-probe'],
    ]);
    const lines = info.mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>
    );
    expect(lines.map(line => line.outcome)).toEqual(['succeeded', 'succeeded']);
    info.mockRestore();
  });

  it.each<[string, (request: MintRequest) => MintResult, string]>([
    [
      'STS is unavailable',
      () => ({ status: 'unavailable', retryAfterSeconds: 5 }),
      'mint unavailable: retry in 5 s',
    ],
    [
      'STS issues the token',
      () => ({
        status: 'ok',
        tokens: [
          {
            status: 'issued',
            audience: 'canary',
            scope: 'canary:denied-probe',
            token: 'issued.probe.token',
            jti: 'jti-probe',
            expiresAt: Math.floor(Date.now() / 1000) + 300,
          },
        ],
      }),
      'STS issued the reserved denied probe',
    ],
    [
      'STS denies for another reason',
      () => ({ status: 'ok', tokens: [{ ...DENIED, reason: 'unknown_scope' }] }),
      'mint denied: unknown_scope',
    ],
    [
      'STS rejects the identity',
      () => ({ status: 'identity_rejected' }),
      'mint denied: identity_rejected',
    ],
  ])('fails the run when %s, and the allowed mint still passes', async (_name, answer, detail) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { fetchFn } = usageIngest();
    const stub = sts(answer);
    const response = await call(
      handler(stub.tokens, fetchFn, undefined, stub.newTokens),
      await stsToken('usage-ingest', 'web', 'web:sts.canary')
    );
    const report = (await response.json()) as StsCanaryReport;
    expect(report.outbound).toEqual({ result: 'ok', status: 204 });
    expect(report.negatives.stsDenied).toEqual({ result: 'failed', status: null, detail });
    expect(JSON.stringify(report)).not.toContain('issued.probe.token');
    const [line] = warn.mock.calls.map(
      ([text]) => JSON.parse(String(text)) as Record<string, unknown>
    );
    expect(line).toMatchObject({ event: 'sts_canary', outcome: 'failed' });
    warn.mockRestore();
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

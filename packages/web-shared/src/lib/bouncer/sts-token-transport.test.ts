import { STS_ISSUERS, type MintRequest } from '@kilocode/sts-contracts';
import { waitUntil } from '@vercel/functions';
import { decide, deliverUsageEventWireBody } from '@kilocode/web-shared/lib/bouncer/client';
import { installBouncerAuth } from '@kilocode/web-shared/lib/bouncer/sts-auth';
import { BouncerStsConfigError } from '@kilocode/web-shared/lib/bouncer/sts-auth-contract';
import {
  BOUNCER_FIRST_MINT_JITTER_MS,
  BOUNCER_NOT_HELD_MEMORY_MS,
  connectBouncerSts,
  createBouncerTransportFor,
} from './sts-token-transport';

// The shipped wiring end to end in one process: `installBouncerAuth` loads the real transport on
// the first call with the flag on, which mints through the real `createHttpServiceTokens` against
// a faked fetch, and the real Bouncer client sends the token.

let mockStsUrl: string = STS_ISSUERS.production;

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  get STS_URL() {
    return mockStsUrl;
  },
  BOUNCER_URL: 'https://bouncer.kiloapps.io',
  INTERNAL_API_SECRET: 'env-only-secret',
}));

jest.mock('@vercel/functions', () => ({
  getCache: jest.fn(() => ({})),
  waitUntil: jest.fn(),
}));

const IDENTITY_TOKEN = 'exchanged-identity-token';
const mockIdentity = jest.fn(async () => IDENTITY_TOKEN);
/** Whether the readiness check finds the deployment's exchanged Vercel token held. */
let mockExchangeHeld = true;
const mockReadinessGet = jest.fn(async () =>
  mockExchangeHeld
    ? { status: 'ok', token: IDENTITY_TOKEN, exp: 0, report: {} }
    : { status: 'failed', detail: 'not held', report: {} }
);
jest.mock('@kilocode/service-token-client/vercel', () => ({
  vercelIdentity: jest.fn(() => mockIdentity),
  SharedExchangedToken: class {
    get = mockReadinessGet;
  },
}));
jest.mock('@vercel/functions/oidc', () => ({
  getVercelOidcToken: jest.fn(async () => 'base-oidc-token'),
}));

const mockFetch = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
const realFetch = global.fetch;
const runtimeNames = ['VERCEL_ENV', 'VERCEL_TARGET_ENV', 'BOUNCER_CLIENT_AUTH'] as const;
const savedRuntime = Object.fromEntries(runtimeNames.map(name => [name, process.env[name]]));

function setRuntime(values: Partial<Record<(typeof runtimeNames)[number], string>>): void {
  for (const name of runtimeNames) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function urlOf(input: Parameters<typeof fetch>[0]): string {
  return input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
}

function bouncerCalls(): Headers[] {
  return mockFetch.mock.calls
    .filter(([input]) => urlOf(input).startsWith('https://bouncer.kiloapps.io/'))
    .map(([, init]) => new Headers(init?.headers));
}

function stsCalls(): MintRequest[] {
  return mockFetch.mock.calls
    .filter(([input]) => urlOf(input) === `${STS_ISSUERS.production}/v1/token`)
    .map(([, init]) => JSON.parse(init?.body as string) as MintRequest);
}

beforeEach(() => {
  mockStsUrl = STS_ISSUERS.production;
  mockExchangeHeld = true;
  setRuntime({
    VERCEL_ENV: 'production',
    VERCEL_TARGET_ENV: 'production',
    BOUNCER_CLIENT_AUTH: 'dual',
  });
  global.fetch = mockFetch as unknown as typeof fetch;
  mockFetch.mockImplementation(async (input, init) => {
    const url = urlOf(input);
    if (url === `${STS_ISSUERS.production}/v1/token`) {
      const request = JSON.parse(init?.body as string) as MintRequest;
      return Response.json({
        status: 'ok',
        tokens: request.tokens.map(({ audience, scope }, index) => ({
          status: 'issued',
          audience,
          scope,
          token: `sts-${scope.slice('bouncer:'.length)}-token`,
          jti: `jti-${index}`,
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        })),
      });
    }
    return Response.json({ enforced: false, spendWatch: false, flags: [] });
  });
  installBouncerAuth('kilocode-ai-gateway');
});

afterEach(async () => {
  // A mint the call stopped waiting for runs on under `waitUntil`; let it end on the faked fetch.
  await Promise.allSettled(jest.mocked(waitUntil).mock.calls.map(([promise]) => promise));
  global.fetch = realFetch;
  globalThis.__kilocodeBouncerAuth = undefined;
  setRuntime(savedRuntime);
  jest.clearAllMocks();
});

describe('the installed Bouncer auth with the real transport', () => {
  it("mints the decide token and the gateway's other scope with the Vercel identity, and sends decide beside the legacy key", async () => {
    await expect(
      decide({ requestId: 'r-1', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1_000 })
    ).resolves.toEqual({ enforced: false, spendWatch: false, flags: [] });

    // One attempt: one STS call per scope, as the client sends one token per audience per call.
    expect(stsCalls()).toEqual([
      { tokens: [{ audience: 'bouncer', scope: 'bouncer:decide' }] },
      { tokens: [{ audience: 'bouncer', scope: 'bouncer:usage.write' }] },
    ]);
    const stsInit = mockFetch.mock.calls.find(
      ([input]) => urlOf(input) === `${STS_ISSUERS.production}/v1/token`
    )?.[1];
    expect(new Headers(stsInit?.headers).get('authorization')).toBe(`Bearer ${IDENTITY_TOKEN}`);
    // Held before the mint, so the mint went out without the first-exchange jitter.
    expect(mockReadinessGet).toHaveBeenCalled();

    const [headers] = bouncerCalls();
    expect(headers.get('authorization')).toBe('Bearer sts-decide-token');
    expect(headers.get('x-internal-api-key')).toBe('env-only-secret');
    expect(headers.get('x-kilo-caller')).toBe('kilocode-ai-gateway');

    // Later calls read the held tokens: no second mint, and usage.write is held already.
    await decide({ requestId: 'r-2', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1_000 });
    await deliverUsageEventWireBody({ requestId: 'r-2' });
    expect(stsCalls()).toHaveLength(2);
    expect(bouncerCalls()[1].get('authorization')).toBe('Bearer sts-decide-token');
    expect(bouncerCalls()[2].get('authorization')).toBe('Bearer sts-usage.write-token');
    expect(stsCalls().flatMap(call => call.tokens.map(token => token.scope))).not.toContain(
      'bouncer:signup.decide'
    );
  });

  it('does not wait for a decide token while the exchanged Vercel token is not held', async () => {
    mockExchangeHeld = false;
    // No first-exchange jitter here; `connectBouncerSts` below tests it with fake timers.
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    try {
      await decide(
        { requestId: 'r-7', tier: 'anonymous', ip: '203.0.113.7' },
        { timeoutMs: 1_000 }
      );
      const [headers] = bouncerCalls();
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('x-internal-api-key')).toBe('env-only-secret');
      // The mint still runs in the background, so the next call finds its token.
      await Promise.allSettled(jest.mocked(waitUntil).mock.calls.map(([promise]) => promise));
      await decide(
        { requestId: 'r-8', tier: 'anonymous', ip: '203.0.113.7' },
        { timeoutMs: 1_000 }
      );
      expect(bouncerCalls()[1].get('authorization')).toBe('Bearer sts-decide-token');
    } finally {
      random.mockRestore();
    }
  });

  it('delivers a usage event with the legacy key alone while its token is not held yet', async () => {
    await expect(deliverUsageEventWireBody({ requestId: 'r-3' })).resolves.toMatchObject({
      delivered: true,
    });
    const [headers] = bouncerCalls();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-internal-api-key')).toBe('env-only-secret');
    expect(headers.get('x-kilo-caller')).toBe('kilocode-ai-gateway');
  });

  it('never presents its identity to the STS of another environment', async () => {
    mockStsUrl = STS_ISSUERS.staging;
    // The deployment starts with these settings: install again, as instrumentation would.
    installBouncerAuth('kilocode-ai-gateway');
    await decide({ requestId: 'r-4', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1_000 });
    expect(stsCalls()).toEqual([]);
    expect(mockIdentity).not.toHaveBeenCalled();
    const [headers] = bouncerCalls();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-internal-api-key')).toBe('env-only-secret');
  });

  it.each([
    ['a preview', { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' }, STS_ISSUERS.development],
    ['staging', { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' }, STS_ISSUERS.staging],
  ])(
    'makes no STS call from %s deployment, even with its own STS_URL',
    async (_name, runtime, issuer) => {
      setRuntime({ ...runtime, BOUNCER_CLIENT_AUTH: 'dual' });
      mockStsUrl = issuer;
      installBouncerAuth('kilocode-ai-gateway');
      await decide(
        { requestId: 'r-6', tier: 'anonymous', ip: '203.0.113.7' },
        { timeoutMs: 1_000 }
      );
      expect(mockFetch.mock.calls.filter(([input]) => urlOf(input).endsWith('/v1/token'))).toEqual(
        []
      );
      expect(mockIdentity).not.toHaveBeenCalled();
      const [headers] = bouncerCalls();
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('x-internal-api-key')).toBe('env-only-secret');
    }
  );

  it('sends no token with the flag off', async () => {
    setRuntime({ VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' });
    await decide({ requestId: 'r-5', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1_000 });
    expect(stsCalls()).toEqual([]);
    const [headers] = bouncerCalls();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-kilo-caller')).toBe('kilocode-ai-gateway');
  });
});

describe('createBouncerTransportFor', () => {
  const connect = jest.fn(() => ({
    tokens: { get: jest.fn(async () => 'token') },
    exchangeReady: async () => true,
  }));

  it('connects to production STS for a production deployment', () => {
    createBouncerTransportFor({
      runtime: { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' },
      stsUrl: STS_ISSUERS.production,
      connect,
    });
    expect(connect).toHaveBeenLastCalledWith(STS_ISSUERS.production);
  });

  it.each([
    [{ VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' }, STS_ISSUERS.staging],
    [{ VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' }, STS_ISSUERS.staging],
    [{ VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' }, STS_ISSUERS.production],
    [{ VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' }, STS_ISSUERS.development],
  ])('refuses %j with STS_URL %s', (runtime, stsUrl) => {
    connect.mockClear();
    expect(() => createBouncerTransportFor({ runtime, stsUrl, connect })).toThrow(
      BouncerStsConfigError
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('refuses a deployment environment with no STS environment', () => {
    expect(() =>
      createBouncerTransportFor({
        runtime: { VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'development' },
        stsUrl: STS_ISSUERS.development,
        connect,
      })
    ).toThrow(BouncerStsConfigError);
  });
});

describe('connectBouncerSts', () => {
  const DECIDE = { audience: 'bouncer', scope: 'bouncer:decide' } as const;
  const ctx = { waitUntil: () => undefined };

  afterEach(() => {
    jest.useRealTimers();
  });

  function connection(options: { held: { value: boolean }; status?: number }) {
    const mint = jest.fn<void, [boolean]>();
    const exchangeHeld = jest.fn(async () => options.held.value);
    const identity = jest.fn(async () => IDENTITY_TOKEN);
    const stsFetch = jest.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(init?.body as string) as MintRequest;
      if (options.status === 503) {
        return Response.json({ status: 'unavailable', retryAfterSeconds: 1 }, { status: 503 });
      }
      return Response.json({
        status: 'ok',
        tokens: request.tokens.map(({ audience, scope }) => ({
          status: 'issued',
          audience,
          scope,
          token: 'sts-token',
          jti: 'jti',
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        })),
      });
    });
    const connected = connectBouncerSts({
      stsIssuer: STS_ISSUERS.production,
      hooks: { mint },
      identity,
      exchangeHeld,
      fetch: stsFetch as unknown as typeof fetch,
      random: () => 0.5,
    });
    return { connected, mint, exchangeHeld, identity, stsFetch };
  }

  it('delays a first-exchange mint by the jitter and reports not ready meanwhile', async () => {
    jest.useFakeTimers();
    const held = { value: false };
    const { connected, mint, stsFetch } = connection({ held });
    const token = connected.tokens.get(DECIDE, ctx);
    // The identity step found no exchanged token, so this mint waits half the jitter range.
    await jest.advanceTimersByTimeAsync(20);
    held.value = true;
    await jest.advanceTimersByTimeAsync(BOUNCER_NOT_HELD_MEMORY_MS);
    await expect(connected.exchangeReady()).resolves.toBe(false);
    await jest.advanceTimersByTimeAsync(BOUNCER_FIRST_MINT_JITTER_MS / 2 - 300);
    expect(stsFetch).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(50);
    await expect(token).resolves.toBe('sts-token');
    expect(stsFetch).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith(true);
    await expect(connected.exchangeReady()).resolves.toBe(true);
  });

  it('mints at once when the exchanged token was already held', async () => {
    jest.useFakeTimers();
    const { connected, stsFetch } = connection({ held: { value: true } });
    const token = connected.tokens.get(DECIDE, ctx);
    await jest.advanceTimersByTimeAsync(20);
    await expect(token).resolves.toBe('sts-token');
    expect(stsFetch).toHaveBeenCalledTimes(1);
  });

  it('runs one readiness check at a time and remembers a miss for the memory window', async () => {
    jest.useFakeTimers();
    const { connected, exchangeHeld } = connection({ held: { value: false } });
    const check = Promise.withResolvers<boolean>();
    exchangeHeld.mockReturnValueOnce(check.promise);
    const first = connected.exchangeReady();
    const second = connected.exchangeReady();
    expect(exchangeHeld).toHaveBeenCalledTimes(1);
    check.resolve(false);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
    await jest.advanceTimersByTimeAsync(BOUNCER_NOT_HELD_MEMORY_MS - 1);
    await expect(connected.exchangeReady()).resolves.toBe(false);
    expect(exchangeHeld).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await connected.exchangeReady();
    expect(exchangeHeld).toHaveBeenCalledTimes(2);
  });

  it('reports a refused or failed STS answer to the mint hook', async () => {
    jest.useFakeTimers();
    const { connected, mint } = connection({ held: { value: true }, status: 503 });
    const token = connected.tokens.get(DECIDE, ctx);
    void token.catch(() => undefined);
    await jest.advanceTimersByTimeAsync(20);
    await expect(token).rejects.toThrow();
    expect(mint).toHaveBeenCalledWith(false);
    expect(mint).not.toHaveBeenCalledWith(true);
  });
});

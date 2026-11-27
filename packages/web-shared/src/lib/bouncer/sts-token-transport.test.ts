import { STS_ISSUERS, type MintRequest } from '@kilocode/sts-contracts';
import { waitUntil } from '@vercel/functions';
import { decide, deliverUsageEventWireBody } from '@kilocode/web-shared/lib/bouncer/client';
import { installBouncerAuth } from '@kilocode/web-shared/lib/bouncer/sts-auth';
import { BouncerStsConfigError } from '@kilocode/web-shared/lib/bouncer/sts-auth-contract';
import { createBouncerTokenReadFor } from './sts-token-transport';

// The shipped wiring end to end in one process: `installBouncerAuth` loads the real transport on
// the first call with the flag on, which mints through the real `createHttpServiceTokens` against
// a faked fetch, and the real Bouncer client sends the token.

let mockStsUrl: string = STS_ISSUERS.production;

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  get STS_URL() {
    return mockStsUrl;
  },
  BOUNCER_URL: 'https://bouncer.example.com',
  INTERNAL_API_SECRET: 'env-only-secret',
}));

jest.mock('@vercel/functions', () => ({
  getCache: jest.fn(() => ({})),
  waitUntil: jest.fn(),
}));

const IDENTITY_TOKEN = 'exchanged-identity-token';
const mockIdentity = jest.fn(async () => IDENTITY_TOKEN);
jest.mock('@kilocode/service-token-client/vercel', () => ({
  vercelIdentity: jest.fn(() => mockIdentity),
}));

const mockFetch = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
const realFetch = global.fetch;
const runtimeNames = ['VERCEL_ENV', 'VERCEL_TARGET_ENV', 'BOUNCER_STS_TOKENS'] as const;
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
    .filter(([input]) => urlOf(input).startsWith('https://bouncer.example.com/'))
    .map(([, init]) => new Headers(init?.headers));
}

function stsCalls(): MintRequest[] {
  return mockFetch.mock.calls
    .filter(([input]) => urlOf(input) === `${STS_ISSUERS.production}/v1/token`)
    .map(([, init]) => JSON.parse(init?.body as string) as MintRequest);
}

beforeEach(() => {
  mockStsUrl = STS_ISSUERS.production;
  setRuntime({
    VERCEL_ENV: 'production',
    VERCEL_TARGET_ENV: 'production',
    BOUNCER_STS_TOKENS: 'on',
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
  it('mints the decide token with the Vercel identity and sends it beside the legacy key', async () => {
    await expect(
      decide({ requestId: 'r-1', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1_000 })
    ).resolves.toEqual({ enforced: false, spendWatch: false, flags: [] });

    expect(stsCalls()).toEqual([{ tokens: [{ audience: 'bouncer', scope: 'bouncer:decide' }] }]);
    const stsInit = mockFetch.mock.calls.find(
      ([input]) => urlOf(input) === `${STS_ISSUERS.production}/v1/token`
    )?.[1];
    expect(new Headers(stsInit?.headers).get('authorization')).toBe(`Bearer ${IDENTITY_TOKEN}`);

    const [headers] = bouncerCalls();
    expect(headers.get('authorization')).toBe('Bearer sts-decide-token');
    expect(headers.get('x-internal-api-key')).toBe('env-only-secret');
    expect(headers.get('x-kilo-caller')).toBe('kilocode-ai-gateway');

    // The second call reads the held token: no second mint.
    await decide({ requestId: 'r-2', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1_000 });
    expect(stsCalls()).toHaveLength(1);
    expect(bouncerCalls()[1].get('authorization')).toBe('Bearer sts-decide-token');
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
  ])('makes no STS call from %s deployment, even with its own STS_URL', async (_name, runtime, issuer) => {
    setRuntime({ ...runtime, BOUNCER_STS_TOKENS: 'on' });
    mockStsUrl = issuer;
    await decide({ requestId: 'r-6', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1_000 });
    expect(mockFetch.mock.calls.filter(([input]) => urlOf(input).endsWith('/v1/token'))).toEqual(
      []
    );
    expect(mockIdentity).not.toHaveBeenCalled();
    const [headers] = bouncerCalls();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-internal-api-key')).toBe('env-only-secret');
  });

  it('sends no token and loads no transport with the flag off', async () => {
    setRuntime({ VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' });
    await decide({ requestId: 'r-5', tier: 'anonymous', ip: '203.0.113.7' }, { timeoutMs: 1_000 });
    expect(stsCalls()).toEqual([]);
    const [headers] = bouncerCalls();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-kilo-caller')).toBe('kilocode-ai-gateway');
  });
});

describe('createBouncerTokenReadFor', () => {
  const createTokens = jest.fn(() => ({ get: jest.fn(async () => 'token') }));

  it('mints from production STS for a production deployment', () => {
    createBouncerTokenReadFor({
      runtime: { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' },
      stsUrl: STS_ISSUERS.production,
      createTokens,
    });
    expect(createTokens).toHaveBeenLastCalledWith(STS_ISSUERS.production);
  });

  it.each([
    [{ VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' }, STS_ISSUERS.staging],
    [{ VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' }, STS_ISSUERS.staging],
    [{ VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' }, STS_ISSUERS.production],
    [{ VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' }, STS_ISSUERS.development],
  ])('refuses %j with STS_URL %s', (runtime, stsUrl) => {
    createTokens.mockClear();
    expect(() => createBouncerTokenReadFor({ runtime, stsUrl, createTokens })).toThrow(
      BouncerStsConfigError
    );
    expect(createTokens).not.toHaveBeenCalled();
  });

  it('refuses a deployment environment with no STS environment', () => {
    expect(() =>
      createBouncerTokenReadFor({
        runtime: { VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'development' },
        stsUrl: STS_ISSUERS.development,
        createTokens,
      })
    ).toThrow(BouncerStsConfigError);
  });
});

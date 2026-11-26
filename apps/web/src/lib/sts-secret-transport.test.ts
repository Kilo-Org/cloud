import { SecretUnavailableError, type Secrets } from '@kilocode/secrets-client';
import { STS_ISSUERS, type BundleResult } from '@kilocode/sts-contracts';
import { getCache } from '@vercel/functions';
import { vercelIdentity } from '@kilocode/service-token-client/vercel';
import { readInternalApiSecret } from '@kilocode/web-shared/lib/internal-api-secret';
import { installWebInternalApiSecretRead, internalApiSecretFromSts } from './sts-secret-reader';
import { createStsSecretReader, stsEnvironmentOfDeployment } from './sts-secret-transport';

// The shipped wiring end to end in one process: `installWebInternalApiSecretRead` loads the real
// transport on the first STS read, which uses the real `createHttpSecrets` against a faked fetch.

const mockStsUrl = STS_ISSUERS.production;

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  get STS_URL() {
    return mockStsUrl;
  },
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

const DELIVERED = 'sts-delivered-secret';
const mockFetch = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
const realFetch = global.fetch;
const runtimeNames = ['VERCEL_ENV', 'VERCEL_TARGET_ENV', 'SECRETS_SOURCE'] as const;
const savedRuntime = Object.fromEntries(runtimeNames.map(name => [name, process.env[name]]));

function setRuntime(values: Partial<Record<(typeof runtimeNames)[number], string>>): void {
  for (const name of runtimeNames) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function okBundle(secrets: Record<string, string>, missing: string[] = []): BundleResult {
  return {
    status: 'ok',
    workload: 'web',
    environment: 'production',
    etag: '"etag-0123456789abcdef"',
    stale: false,
    fetchedAt: new Date().toISOString(),
    secrets: Object.fromEntries(
      Object.entries(secrets).map(([name, value]) => [name, { value, version: 1 }])
    ),
    missing,
  };
}

function answer(result: BundleResult, status: number): void {
  mockFetch.mockResolvedValue(new Response(JSON.stringify(result), { status }));
}

beforeEach(() => {
  mockFetch.mockReset();
  mockIdentity.mockClear();
  jest.mocked(getCache).mockClear();
  jest.mocked(vercelIdentity).mockClear();
  global.fetch = mockFetch as unknown as typeof fetch;
  setRuntime({});
});

afterEach(() => {
  global.fetch = realFetch;
  for (const name of runtimeNames) {
    const value = savedRuntime[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  globalThis.__kilocodeInternalApiSecretRead = undefined;
});

describe('stsEnvironmentOfDeployment', () => {
  it.each([
    ['production', 'production', 'production'],
    ['preview', 'staging', 'staging'],
    ['preview', 'preview', 'development'],
    [undefined, undefined, 'development'],
  ] as const)('maps VERCEL_ENV=%s VERCEL_TARGET_ENV=%s to %s', (environment, target, expected) => {
    expect(stsEnvironmentOfDeployment({ VERCEL_ENV: environment, VERCEL_TARGET_ENV: target })).toBe(
      expected
    );
  });

  it.each([
    ['production', 'staging'],
    ['production', undefined],
    ['preview', 'production'],
    ['preview', 'qa'],
    ['preview', undefined],
    ['development', 'development'],
    [undefined, 'production'],
  ])('refuses VERCEL_ENV=%s VERCEL_TARGET_ENV=%s', (environment, target) => {
    expect(() =>
      stsEnvironmentOfDeployment({ VERCEL_ENV: environment, VERCEL_TARGET_ENV: target })
    ).toThrow('This deployment environment has no STS environment');
  });
});

describe('createStsSecretReader', () => {
  function fakeSecrets(): Secrets {
    return {
      get: jest.fn(async () => DELIVERED),
      snapshot: jest.fn(),
    };
  }

  it.each([
    ['staging with production STS', 'staging', STS_ISSUERS.production],
    ['production with staging STS', 'production', STS_ISSUERS.staging],
    ['a preview with production STS', 'preview', STS_ISSUERS.production],
  ])('refuses %s before building a client', async (_case, target, stsUrl) => {
    const createSecrets = jest.fn(fakeSecrets);
    const read = createStsSecretReader({
      runtime: {
        VERCEL_ENV: target === 'production' ? 'production' : 'preview',
        VERCEL_TARGET_ENV: target,
      },
      stsUrl,
      createSecrets,
      waitUntil: () => undefined,
    });
    await expect(read('INTERNAL_API_SECRET')).rejects.toThrow(
      'STS_URL is not the STS issuer of this deployment environment'
    );
    expect(createSecrets).not.toHaveBeenCalled();
  });

  it('builds one client for the staging issuer and reads through it', async () => {
    const secrets = fakeSecrets();
    const createSecrets = jest.fn(() => secrets);
    const keepAlive = () => undefined;
    const read = createStsSecretReader({
      runtime: { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' },
      stsUrl: STS_ISSUERS.staging,
      createSecrets,
      waitUntil: keepAlive,
    });
    await expect(read('INTERNAL_API_SECRET')).resolves.toBe(DELIVERED);
    await expect(read('INTERNAL_API_SECRET')).resolves.toBe(DELIVERED);
    expect(createSecrets).toHaveBeenCalledTimes(1);
    expect(createSecrets).toHaveBeenCalledWith(STS_ISSUERS.staging);
    expect(secrets.get).toHaveBeenCalledWith('INTERNAL_API_SECRET', { waitUntil: keepAlive });
  });
});

describe('internalApiSecretFromSts', () => {
  it.each(['sts', 'secrets-store'])(
    'is false without the installed web read, whatever SECRETS_SOURCE says (%s)',
    source => {
      setRuntime({ SECRETS_SOURCE: source });
      expect(internalApiSecretFromSts()).toBe(false);
    }
  );

  it('follows the selector once the web read is installed', () => {
    installWebInternalApiSecretRead();
    expect(internalApiSecretFromSts()).toBe(false);
    setRuntime({ SECRETS_SOURCE: 'sts' });
    expect(internalApiSecretFromSts()).toBe(true);
    setRuntime({ SECRETS_SOURCE: 'secrets-store' });
    expect(() => internalApiSecretFromSts()).toThrow('SECRETS_SOURCE must be either');
  });
});

describe('installWebInternalApiSecretRead', () => {
  beforeEach(() => {
    installWebInternalApiSecretRead();
  });

  it.each([undefined, 'env'])(
    'constructs nothing and calls nothing while the source is %s',
    async source => {
      setRuntime({
        VERCEL_ENV: 'production',
        VERCEL_TARGET_ENV: 'production',
        SECRETS_SOURCE: source,
      });
      await expect(readInternalApiSecret()).resolves.toBe('env-only-secret');
      expect(getCache).not.toHaveBeenCalled();
      expect(vercelIdentity).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    }
  );

  it.each(['', 'STS', 'secrets-store'])(
    'refuses SECRETS_SOURCE=%j without reading either source',
    async source => {
      setRuntime({
        VERCEL_ENV: 'production',
        VERCEL_TARGET_ENV: 'production',
        SECRETS_SOURCE: source,
      });
      await expect(readInternalApiSecret()).rejects.toThrow(
        'SECRETS_SOURCE must be either "env" or "sts"'
      );
      expect(vercelIdentity).not.toHaveBeenCalled();
      expect(mockFetch).not.toHaveBeenCalled();
    }
  );

  it('reads the delivered value from production STS with the exchanged Vercel identity', async () => {
    setRuntime({
      VERCEL_ENV: 'production',
      VERCEL_TARGET_ENV: 'production',
      SECRETS_SOURCE: 'sts',
    });
    answer(okBundle({ INTERNAL_API_SECRET: DELIVERED }), 200);

    await expect(readInternalApiSecret()).resolves.toBe(DELIVERED);

    expect(getCache).toHaveBeenCalledWith(expect.objectContaining({ namespace: 'sts-exchange' }));
    expect(vercelIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ stsAudience: STS_ISSUERS.production })
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe(`${STS_ISSUERS.production}/v1/bundle`);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${IDENTITY_TOKEN}`);
  });

  it('refuses a staging deployment whose STS_URL is production without any request', async () => {
    setRuntime({ VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging', SECRETS_SOURCE: 'sts' });
    await expect(readInternalApiSecret()).rejects.toThrow(
      'STS_URL is not the STS issuer of this deployment environment'
    );
    expect(vercelIdentity).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['a denial', { status: 'denied', reason: 'identity_rejected' } as const, 401, 'denied'],
    ['a secret the policy does not grant', okBundle({ OTHER_SECRET: 'x' }), 200, 'not_granted'],
    ['a granted secret the manager lacks', okBundle({}, ['INTERNAL_API_SECRET']), 200, 'missing'],
    [
      'an outage',
      {
        status: 'unavailable',
        reason: 'manager_unreachable_no_copy',
        retryAfterSeconds: 3600,
      } as const,
      503,
      'unavailable',
    ],
  ])(
    'rejects on %s and never falls back to the environment value',
    async (_case, result, status, reason) => {
      setRuntime({
        VERCEL_ENV: 'production',
        VERCEL_TARGET_ENV: 'production',
        SECRETS_SOURCE: 'sts',
      });
      answer(result, status);
      const read = readInternalApiSecret();
      await expect(read).rejects.toBeInstanceOf(SecretUnavailableError);
      await expect(read).rejects.toMatchObject({ reason });
    }
  );
});

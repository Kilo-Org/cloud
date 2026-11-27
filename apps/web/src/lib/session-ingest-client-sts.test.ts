import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { STS_ISSUERS } from '@kilocode/sts-contracts';
import type * as SessionIngestClient from './session-ingest-client';

// `invalidateOrganizationSessionAccess` under `SESSION_INGEST_SENDER_AUTH`: the real switch, the
// real lazy STS module and the shared token module, with the token client, the Vercel identity and
// the network faked. The legacy request shape is pinned in session-ingest-client.test.ts.

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/auth/kilo-token-signing', () => ({
  generateBoundedInternalServiceToken: jest.fn().mockReturnValue('mock-jwt-token'),
}));
jest.mock('@vercel/functions', () => ({
  getCache: jest.fn(() => ({})),
  waitUntil: jest.fn(),
}));

const mockIdentity = jest.fn(async () => 'exchanged-identity-token');
jest.mock('@kilocode/service-token-client/vercel', () => ({
  vercelIdentity: jest.fn(() => mockIdentity),
}));

const mockTokenGet = jest.fn<Promise<string>, [unknown, unknown]>();
const mockCreateHttpServiceTokens = jest.fn((_options: { stsUrl: string }) => ({
  get: mockTokenGet,
}));
jest.mock('@kilocode/service-token-client', () => ({
  ...(jest.requireActual('@kilocode/service-token-client') as Record<string, unknown>),
  createHttpServiceTokens: (options: { stsUrl: string }) => mockCreateHttpServiceTokens(options),
}));

const PRODUCTION = { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' };
const STAGING = { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' };
const INGEST_URL = 'https://ingest.test.example.com';
const SECRET = 'legacy-internal-secret';
const TOKEN = 'sts-service-token';
const USER_ID = 'usr_removed';
const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';

type Runtime = Partial<Record<'VERCEL_ENV' | 'VERCEL_TARGET_ENV', string>>;
const runtimeNames = ['VERCEL_ENV', 'VERCEL_TARGET_ENV'] as const;
const savedRuntime = Object.fromEntries(runtimeNames.map(name => [name, process.env[name]]));

function setRuntime(values: Runtime): void {
  for (const name of runtimeNames) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

async function loadClient(config: {
  auth?: string;
  url?: string;
  runtime?: Runtime;
}): Promise<typeof SessionIngestClient> {
  setRuntime(config.runtime ?? PRODUCTION);
  jest.resetModules();
  jest.doMock('@kilocode/web-shared/lib/config.server', () => ({
    SESSION_INGEST_WORKER_URL: config.url ?? INGEST_URL,
    SESSION_INGEST_SENDER_AUTH: config.auth ?? '',
    INTERNAL_API_SECRET: SECRET,
  }));
  const client = await import('./session-ingest-client');
  jest.dontMock('@kilocode/web-shared/lib/config.server');
  return client;
}

let mockFetch: jest.SpiedFunction<typeof fetch>;
let consoleError: jest.SpyInstance;

beforeEach(() => {
  mockTokenGet.mockReset();
  mockCreateHttpServiceTokens.mockClear();
  mockFetch = jest.spyOn(globalThis, 'fetch');
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setRuntime(savedRuntime);
  jest.restoreAllMocks();
});

describe('invalidateOrganizationSessionAccess, sts', () => {
  test('Vercel production sends only the invalidate token by default, never the secret', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    mockTokenGet.mockResolvedValue(TOKEN);
    const client = await loadClient({});
    await client.invalidateOrganizationSessionAccess(USER_ID, ORGANIZATION_ID);

    expect(mockCreateHttpServiceTokens.mock.calls[0]?.[0].stsUrl).toBe(STS_ISSUERS.production);
    expect(mockTokenGet).toHaveBeenCalledTimes(1);
    expect(mockTokenGet.mock.calls[0]?.[0]).toEqual({
      audience: 'session-ingest',
      scope: 'session-ingest:session-access.invalidate',
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe(`${INGEST_URL}/internal/session-access/invalidate`);
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(headers.has('x-internal-secret')).toBe(false);
    expect(JSON.stringify(init)).not.toContain(SECRET);
    expect(init?.redirect).toBe('error');
    expect(init?.body).toBe(JSON.stringify({ kiloUserId: USER_ID, organizationId: ORGANIZATION_ID }));
  });

  test('no token fails the call and sends nothing', async () => {
    mockTokenGet.mockRejectedValue(new Error('no Vercel token for the STS audience'));
    const client = await loadClient({ auth: 'sts' });
    await expect(
      client.invalidateOrganizationSessionAccess(USER_ID, ORGANIZATION_ID)
    ).rejects.toThrow('No STS service token for session-ingest:session-access.invalidate');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      'session ingest invalidate: no STS token; request refused',
      { errorName: 'Error' }
    );
  });
});

describe('invalidateOrganizationSessionAccess, legacy and refused', () => {
  test('staging keeps the internal secret when the switch is unset', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const client = await loadClient({ runtime: STAGING });
    await client.invalidateOrganizationSessionAccess(USER_ID, ORGANIZATION_ID);
    const init = mockFetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('x-internal-secret')).toBe(SECRET);
    expect(init?.redirect).toBeUndefined();
    expect(mockCreateHttpServiceTokens).not.toHaveBeenCalled();
  });

  test.each([
    ['an invalid switch', { auth: 'dual' }, 'must be legacy or sts'],
    ['sts on staging', { auth: 'sts', runtime: STAGING }, 'production'],
    ['sts to a plaintext URL', { url: 'http://ingest.test.example.com' }, 'https receiver URL'],
  ] as const)('%s fails the call; nothing is sent', async (_name, config, message) => {
    const client = await loadClient(config);
    await expect(
      client.invalidateOrganizationSessionAccess(USER_ID, ORGANIZATION_ID)
    ).rejects.toThrow(message);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCreateHttpServiceTokens).not.toHaveBeenCalled();
  });
});

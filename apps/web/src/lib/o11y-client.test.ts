import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { z } from 'zod';
import {
  STS_ISSUERS,
  STS_O11Y_ALERTING_READ,
  STS_O11Y_ALERTING_WRITE,
} from '@kilocode/sts-contracts';
import type { O11yAlertingMethod } from './o11y-alerting-sts';
import { resolveO11yAlertingSender } from './o11y-client';
import type * as O11yClient from './o11y-client';

// The client end to end in one process: the real switch, the real lazy STS module and the shared
// token module, with the token client, the Vercel identity and the network faked.

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
const PREVIEW = { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'preview' };
const LOCAL = {};
const PRODUCTION_URL = 'https://o11y.kiloapps.io';
const LOCAL_URL = 'http://localhost:8801';
const SECRET = 'legacy-o11y-secret';
const TOKEN = 'sts-service-token';

type Runtime = Partial<Record<'VERCEL_ENV' | 'VERCEL_TARGET_ENV', string>>;
const runtimeNames = ['VERCEL_ENV', 'VERCEL_TARGET_ENV'] as const;
const savedRuntime = Object.fromEntries(runtimeNames.map(name => [name, process.env[name]]));
const originalFetch = globalThis.fetch;
const mockFetch = jest.fn<Promise<Response>, Parameters<typeof fetch>>();

function setRuntime(values: Runtime): void {
  for (const name of runtimeNames) {
    const value = values[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

/**
 * A fresh client module: it resolves its switch from configuration when it loads. Also returns
 * that registry's `ServiceTokenError`, the class the token module checks errors against.
 */
async function loadClient(config: {
  auth?: string;
  secret?: string;
  url?: string;
  runtime?: Runtime;
}) {
  setRuntime(config.runtime ?? PRODUCTION);
  jest.resetModules();
  jest.doMock('@kilocode/web-shared/lib/config.server', () => ({
    O11Y_SERVICE_URL: config.url ?? PRODUCTION_URL,
    O11Y_KILO_GATEWAY_CLIENT_SECRET: config.secret ?? SECRET,
    O11Y_ALERTING_SENDER_AUTH: config.auth ?? '',
  }));
  const client = await import('./o11y-client');
  const { ServiceTokenError } = await import('@kilocode/service-token-client');
  jest.dontMock('@kilocode/web-shared/lib/config.server');
  return { client, ServiceTokenError };
}

const OkSchema = z.object({ success: z.boolean() });

/** One request of each shape the admin alerts router makes. */
const REQUESTS = {
  GET: { path: '/alerting/config' },
  PUT: { path: '/alerting/config', method: 'PUT', body: { model: 'm', enabled: true } },
  DELETE: {
    path: '/alerting/ttfb-config',
    method: 'DELETE',
    searchParams: new URLSearchParams({ model: 'm' }),
  },
} as const satisfies Record<
  O11yAlertingMethod,
  { path: string; method?: O11yAlertingMethod; body?: unknown; searchParams?: URLSearchParams }
>;

function send(client: typeof O11yClient, method: O11yAlertingMethod) {
  return client.fetchO11yJson({
    ...REQUESTS[method],
    schema: OkSchema,
    errorMessage: 'Failed',
    parseErrorMessage: 'Invalid',
  });
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  mockTokenGet.mockReset();
  mockCreateHttpServiceTokens.mockClear();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => Response.json({ success: true }));
  globalThis.fetch = mockFetch as typeof fetch;
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRuntime(savedRuntime);
  jest.restoreAllMocks();
});

describe('O11Y_ALERTING_SENDER_AUTH', () => {
  test.each([undefined, '', 'legacy'])('%j selects the shared secret', auth => {
    expect(
      resolveO11yAlertingSender({
        auth,
        serviceUrl: PRODUCTION_URL,
        secret: SECRET,
        runtime: PRODUCTION,
      })
    ).toEqual({ kind: 'legacy', secret: SECRET });
  });

  test.each(['dual', 'STS', 'Legacy', ' sts', 'sts ', 'true', 'legacy-and-sts', 'off'])(
    'refuses %j',
    auth => {
      expect(
        resolveO11yAlertingSender({
          auth,
          serviceUrl: PRODUCTION_URL,
          secret: SECRET,
          runtime: PRODUCTION,
        })
      ).toEqual({ kind: 'refused', reason: 'invalid_auth' });
    }
  );

  test('sts on Vercel production goes only to the production o11y origin', () => {
    expect(
      resolveO11yAlertingSender({
        auth: 'sts',
        serviceUrl: PRODUCTION_URL,
        secret: SECRET,
        runtime: PRODUCTION,
      })
    ).toEqual({ kind: 'sts', environment: 'production' });
    for (const serviceUrl of [
      'https://o11y.example.test',
      'https://o11y.kiloapps.io:8443',
      LOCAL_URL,
      '',
    ]) {
      expect(
        resolveO11yAlertingSender({ auth: 'sts', serviceUrl, secret: '', runtime: PRODUCTION })
      ).toEqual({ kind: 'refused', reason: 'origin_mismatch' });
    }
  });

  test.each([
    ['staging', STAGING],
    ['a preview', PREVIEW],
    ['Vercel development', { VERCEL_ENV: 'development', VERCEL_TARGET_ENV: 'development' }],
  ])('sts is production only: %s is refused', (_name, runtime) => {
    expect(
      resolveO11yAlertingSender({
        auth: 'sts',
        serviceUrl: PRODUCTION_URL,
        secret: SECRET,
        runtime,
      })
    ).toEqual({ kind: 'refused', reason: 'sts_production_only' });
  });

  test('a process outside Vercel maps to development STS and the local o11y origin', () => {
    expect(
      resolveO11yAlertingSender({ auth: 'sts', serviceUrl: LOCAL_URL, secret: '', runtime: LOCAL })
    ).toEqual({ kind: 'sts', environment: 'development' });
  });
});

describe('o11y alerting client, legacy', () => {
  test.each([
    ['GET', `${PRODUCTION_URL}/alerting/config`, { 'X-O11Y-ADMIN-TOKEN': SECRET }, undefined],
    [
      'PUT',
      `${PRODUCTION_URL}/alerting/config`,
      { 'X-O11Y-ADMIN-TOKEN': SECRET, 'Content-Type': 'application/json' },
      JSON.stringify({ model: 'm', enabled: true }),
    ],
    [
      'DELETE',
      `${PRODUCTION_URL}/alerting/ttfb-config?model=m`,
      { 'X-O11Y-ADMIN-TOKEN': SECRET },
      undefined,
    ],
  ] as const)(
    '%s sends the shared secret in X-O11Y-ADMIN-TOKEN, as before',
    async (method, url, headers, body) => {
      const { client } = await loadClient({});
      await expect(send(client, method)).resolves.toEqual({ success: true });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]).toEqual([url, { method, headers, body, redirect: 'error' }]);
      expect(mockCreateHttpServiceTokens).not.toHaveBeenCalled();
      expect(mockTokenGet).not.toHaveBeenCalled();
    }
  );

  test('an unset secret still sends the empty header, as before', async () => {
    const { client } = await loadClient({ auth: 'legacy', secret: '' });
    await send(client, 'GET');
    expect(mockFetch.mock.calls[0]?.[1]?.headers).toEqual({ 'X-O11Y-ADMIN-TOKEN': '' });
  });
});

describe('o11y alerting client, sts', () => {
  test.each([
    ['GET', STS_O11Y_ALERTING_READ],
    ['PUT', STS_O11Y_ALERTING_WRITE],
    ['DELETE', STS_O11Y_ALERTING_WRITE],
  ] as const)(
    '%s sends only a %o token from production STS, never the secret',
    async (method, scope) => {
      mockTokenGet.mockResolvedValue(TOKEN);
      const { client } = await loadClient({ auth: 'sts' });
      await expect(send(client, method)).resolves.toEqual({ success: true });

      expect(mockCreateHttpServiceTokens).toHaveBeenCalledTimes(1);
      expect(mockCreateHttpServiceTokens.mock.calls[0]?.[0].stsUrl).toBe(STS_ISSUERS.production);
      expect(mockTokenGet).toHaveBeenCalledTimes(1);
      expect(mockTokenGet.mock.calls[0]?.[0]).toEqual(scope);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const init = mockFetch.mock.calls[0]?.[1];
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(headers.has('x-o11y-admin-token')).toBe(false);
      expect(JSON.stringify(init)).not.toContain(SECRET);
      expect(init?.redirect).toBe('error');
    }
  );

  test('a process outside Vercel mints from development STS for the local o11y', async () => {
    mockTokenGet.mockResolvedValue(TOKEN);
    const { client } = await loadClient({ auth: 'sts', url: LOCAL_URL, runtime: LOCAL });
    await send(client, 'GET');
    expect(mockCreateHttpServiceTokens.mock.calls[0]?.[0].stsUrl).toBe(STS_ISSUERS.development);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(`${LOCAL_URL}/alerting/config`);
  });

  test.each([
    ['a denied mint', 'denied'],
    ['an unavailable STS', 'unavailable'],
    ['a failed Vercel identity', 'identity'],
  ] as const)(
    '%s fails the request with an error for the admin page; nothing is sent',
    async (_name, kind) => {
      const { client, ServiceTokenError } = await loadClient({ auth: 'sts' });
      mockTokenGet.mockRejectedValue(
        kind === 'denied'
          ? new ServiceTokenError(
              { reason: 'denied', deniedReason: 'scope_not_allowed' },
              STS_O11Y_ALERTING_WRITE
            )
          : kind === 'unavailable'
            ? new ServiceTokenError(
                { reason: 'unavailable', retryAfterSeconds: 4 },
                STS_O11Y_ALERTING_WRITE
              )
            : new Error('no Vercel token for the STS audience: exchange answered 500')
      );

      const result = send(client, 'PUT');
      await expect(result).rejects.toBeInstanceOf(client.O11yRequestError);
      await expect(result).rejects.toMatchObject({
        status: 503,
        message: 'No STS service token for o11y alerting; try again',
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        'o11y alerting: no STS token; request refused',
        kind === 'denied'
          ? { errorName: 'ServiceTokenError', reason: 'denied', deniedReason: 'scope_not_allowed' }
          : kind === 'unavailable'
            ? { errorName: 'ServiceTokenError', reason: 'unavailable' }
            : { errorName: 'Error' }
      );
    }
  );
});

describe('o11y alerting client, refused', () => {
  test.each([
    ['an invalid switch', { auth: 'STS' }, 'invalid_auth', 'must be legacy or sts'],
    ['sts on staging', { auth: 'sts', runtime: STAGING }, 'sts_production_only', 'production only'],
    [
      'sts on a preview',
      { auth: 'sts', runtime: PREVIEW },
      'sts_production_only',
      'production only',
    ],
    [
      'sts to another origin',
      { auth: 'sts', url: 'https://o11y.example.test' },
      'origin_mismatch',
      "not o11y's origin",
    ],
  ] as const)('%s fails every request; nothing is sent', async (_name, config, reason, message) => {
    const { client } = await loadClient(config);
    for (const method of ['GET', 'PUT', 'DELETE'] as const) {
      const result = send(client, method);
      await expect(result).rejects.toBeInstanceOf(client.O11yRequestError);
      await expect(result).rejects.toMatchObject({
        status: 500,
        message: expect.stringContaining(message),
      });
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCreateHttpServiceTokens).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      'o11y alerting: invalid sender configuration; request refused',
      { reason }
    );
  });
});

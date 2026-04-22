import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockImportPKCS8, mockSign } = vi.hoisted(() => ({
  mockImportPKCS8: vi.fn(async () => ({})),
  mockSign: vi.fn(async () => 'test-jwt'),
}));

vi.mock('jose', () => ({
  importPKCS8: mockImportPKCS8,
  SignJWT: class {
    setProtectedHeader() {
      return this;
    }
    setIssuer() {
      return this;
    }
    setSubject() {
      return this;
    }
    setIssuedAt() {
      return this;
    }
    setExpirationTime() {
      return this;
    }
    async sign() {
      return await mockSign();
    }
  },
}));

import type { BillingWorkerEnv } from './types.js';
import { getMissingSnowflakeConfig, queryKiloclawActiveUserIds } from './snowflake.js';

function createEnv(): BillingWorkerEnv {
  return {
    HYPERDRIVE: { connectionString: 'postgres://test' },
    LIFECYCLE_QUEUE: {
      send: vi.fn(),
      sendBatch: vi.fn(),
    },
    TRIAL_INACTIVITY_QUEUE: {
      send: vi.fn(),
      sendBatch: vi.fn(),
    },
    KILOCLAW: {
      fetch: vi.fn(),
    },
    KILOCODE_BACKEND_BASE_URL: 'https://app.kilo.ai',
    STRIPE_KILOCLAW_COMMIT_PRICE_ID: 'price_commit',
    STRIPE_KILOCLAW_STANDARD_PRICE_ID: 'price_standard',
    STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID: 'price_standard_intro',
    INTERNAL_API_SECRET: 'next-internal-api-secret',
    KILOCLAW_INTERNAL_API_SECRET: 'claw-secret',
    SNOWFLAKE_ACCOUNT_HOST: 'fyc17898.us-east-1',
    SNOWFLAKE_JWT_ACCOUNT_IDENTIFIER: 'FYC17898',
    SNOWFLAKE_USERNAME: 'KILOCODE_USER',
    SNOWFLAKE_ROLE: 'KILOCODE_ROLE',
    SNOWFLAKE_WAREHOUSE: 'WH_KILOCODE',
    SNOWFLAKE_DATABASE: 'KILO_DW',
    SNOWFLAKE_SCHEMA: 'DBT_PROD',
    SNOWFLAKE_PRIVATE_KEY_PEM: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
    SNOWFLAKE_PUBLIC_KEY_FINGERPRINT: 'SHA256:test',
  };
}

describe('queryKiloclawActiveUserIds', () => {
  beforeEach(() => {
    mockImportPKCS8.mockClear();
    mockSign.mockClear();
    vi.stubGlobal('crypto', webcrypto);
    vi.spyOn(webcrypto, 'randomUUID').mockReturnValue('11111111-1111-4111-8111-111111111111');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns active user ids from a direct 200 response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [['user-1'], ['user-2']] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );

    const userIds = await queryKiloclawActiveUserIds({
      env: createEnv(),
      userIds: ['user-1', 'user-2'],
      log: vi.fn(),
    });

    expect([...userIds]).toEqual(['user-1', 'user-2']);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [requestUrl, requestInit] = fetchSpy.mock.calls[0];
    expect(String(requestUrl)).toContain('requestId=11111111-1111-4111-8111-111111111111');
    expect(String(requestUrl)).not.toContain('retry=true');
    expect(requestInit?.method).toBe('POST');

    const body = JSON.parse(String(requestInit?.body)) as {
      statement: string;
      bindings: Record<string, { type: string; value: string }>;
    };
    expect(body.statement).toContain('kilo_user_id in (?, ?)');
    expect(body.bindings).toEqual({
      '1': { type: 'TEXT', value: 'user-1' },
      '2': { type: 'TEXT', value: 'user-2' },
    });
  });

  it('polls the statement status endpoint after a 202 response', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statementHandle: 'handle-1',
            statementStatusUrl: '/api/v2/statements/handle-1',
          }),
          {
            status: 202,
            headers: { 'content-type': 'application/json' },
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [['user-1']] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    const userIds = await queryKiloclawActiveUserIds({
      env: createEnv(),
      userIds: ['user-1'],
      log: vi.fn(),
    });

    expect([...userIds]).toEqual(['user-1']);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[1][0])).toBe(
      'https://fyc17898.us-east-1/api/v2/statements/handle-1'
    );
    expect(fetchSpy.mock.calls[1][1]?.method).toBeUndefined();
  });

  it('retries a 429 submit by resubmitting the POST with retry=true', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

    const pendingUserIds = queryKiloclawActiveUserIds({
      env: createEnv(),
      userIds: ['user-1'],
      log: vi.fn(),
    });

    await vi.runAllTimersAsync();
    const userIds = await pendingUserIds;

    expect([...userIds]).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0][0])).toContain(
      'requestId=11111111-1111-4111-8111-111111111111'
    );
    expect(String(fetchSpy.mock.calls[0][0])).not.toContain('retry=true');
    expect(String(fetchSpy.mock.calls[1][0])).toContain(
      'requestId=11111111-1111-4111-8111-111111111111'
    );
    expect(String(fetchSpy.mock.calls[1][0])).toContain('retry=true');
    expect(fetchSpy.mock.calls[0][1]?.method).toBe('POST');
    expect(fetchSpy.mock.calls[1][1]?.method).toBe('POST');
  });

  it('throws on 422 query failures so the caller can fail open', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ message: 'bad statement' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      })
    );

    await expect(
      queryKiloclawActiveUserIds({
        env: createEnv(),
        userIds: ['user-1'],
        log: vi.fn(),
      })
    ).rejects.toThrow('bad statement');
  });
});

describe('getMissingSnowflakeConfig', () => {
  it('reports missing required Snowflake env vars', () => {
    const env = createEnv();
    env.SNOWFLAKE_ACCOUNT_HOST = '';
    env.SNOWFLAKE_PRIVATE_KEY_PEM = undefined;

    expect(getMissingSnowflakeConfig(env)).toEqual([
      'SNOWFLAKE_ACCOUNT_HOST',
      'SNOWFLAKE_PRIVATE_KEY_PEM',
    ]);
  });
});

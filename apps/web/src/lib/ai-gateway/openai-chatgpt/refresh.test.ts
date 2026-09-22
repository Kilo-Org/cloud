jest.mock('@/lib/drizzle', () => ({
  db: {
    select: jest.fn(),
    transaction: jest.fn(),
    update: jest.fn(),
  },
}));

jest.mock('@/lib/config.server', () => ({
  BYOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  OPENAI_CLIENT_ID: 'test-client-id',
  OPENAI_CLIENT_SECRET: 'super-secret-value',
}));

jest.mock('@/lib/auth/openai/config', () => ({
  OPENAI_TOKEN_ENDPOINT: 'https://auth.openai.com/api/accounts/oauth/token',
  OPENAI_RESOURCE: 'https://api.openai.com/v1',
}));

import { db } from '@/lib/drizzle';
import { encryptApiKey, decryptApiKey } from '@/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY, OPENAI_CLIENT_ID, OPENAI_CLIENT_SECRET } from '@/lib/config.server';
import { OPENAI_TOKEN_ENDPOINT, OPENAI_RESOURCE } from '@/lib/auth/openai/config';
import {
  OPENAI_CHATGPT_RECONNECT_MESSAGE,
  OPENAI_CHATGPT_REFRESH_MAX_BACKOFF_MS,
  resolveOpenAiChatGptAccessToken,
} from './refresh';
import type { OpenAiChatGptOwner } from './store';
import { OpenAiChatGptConnectionSchema, type OpenAiChatGptConnection } from './types';

type MockDb = {
  select: jest.Mock;
  transaction: jest.Mock;
  update: jest.Mock;
};

type StoredRow = { encrypted_connection: ReturnType<typeof encryptApiKey>; is_enabled: boolean };

const TEST_USER_ID = 'user-1';
const USER_OWNER: OpenAiChatGptOwner = { kiloUserId: TEST_USER_ID, organizationId: null };

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function buildConnection(
  overrides: Partial<OpenAiChatGptConnection> = {}
): OpenAiChatGptConnection {
  return {
    access_token: 'stored-access-token',
    refresh_token: 'stored-refresh-token',
    expires_at: nowSeconds() - 10,
    scope: 'openid profile email offline_access',
    token_type: 'Bearer',
    issuer: 'https://auth.openai.com',
    client_id: 'test-client-id',
    subject: 'subject-1',
    email: 'user@example.com',
    connected_at: '2026-09-16T00:00:00.000Z',
    status: 'connected',
    ...overrides,
  };
}

function encryptedRow(connection: OpenAiChatGptConnection): StoredRow {
  return {
    encrypted_connection: encryptApiKey(JSON.stringify(connection), BYOK_ENCRYPTION_KEY),
    is_enabled: true,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: async () => body,
  } as unknown as Response;
}

function decodeStored(setCall: Record<string, unknown>): OpenAiChatGptConnection {
  const encrypted = setCall.encrypted_connection as ReturnType<typeof encryptApiKey>;
  return OpenAiChatGptConnectionSchema.parse(
    JSON.parse(decryptApiKey(encrypted, BYOK_ENCRYPTION_KEY))
  );
}

function expectedBasicAuth(): string {
  return `Basic ${Buffer.from(
    `${encodeURIComponent(OPENAI_CLIENT_ID)}:${encodeURIComponent(OPENAI_CLIENT_SECRET)}`
  ).toString('base64')}`;
}

/**
 * Records the delays passed to `setTimeout` and fires each timer immediately,
 * so a test can assert the backoff without waiting for it.
 */
function captureRetryDelays(): { values: number[]; restore: () => void } {
  const values: number[] = [];
  const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay?: number
  ) => {
    if (typeof delay === 'number') values.push(delay);
    callback();
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  return { values, restore: () => spy.mockRestore() };
}

describe('resolveOpenAiChatGptAccessToken', () => {
  const mockDb = db as unknown as MockDb;
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;

  let storedRow: StoredRow | null = null;
  const txUpdateSetCalls: Array<Record<string, unknown>> = [];
  const markUpdateSetCalls: Array<Record<string, unknown>> = [];

  const selectChain = () => ({
    from: jest.fn(() => ({
      where: jest.fn(() => ({
        limit: jest.fn(() => Promise.resolve(storedRow ? [storedRow] : [])),
      })),
    })),
  });

  const txSelectChain = () => ({
    from: jest.fn(() => ({
      where: jest.fn(() => ({
        for: jest.fn(() => ({
          limit: jest.fn(() => Promise.resolve(storedRow ? [storedRow] : [])),
        })),
      })),
    })),
  });

  beforeEach(() => {
    storedRow = null;
    txUpdateSetCalls.length = 0;
    markUpdateSetCalls.length = 0;
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;

    mockDb.select.mockReset();
    mockDb.select.mockImplementation(selectChain);

    mockDb.update.mockReset();
    mockDb.update.mockImplementation(() => ({
      set: jest.fn((values: Record<string, unknown>) => {
        markUpdateSetCalls.push(values);
        return { where: jest.fn(() => Promise.resolve(undefined)) };
      }),
    }));

    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
      callback({
        select: jest.fn(txSelectChain),
        update: jest.fn(() => ({
          set: jest.fn((values: Record<string, unknown>) => {
            txUpdateSetCalls.push(values);
            return { where: jest.fn(() => Promise.resolve(undefined)) };
          }),
        })),
      })
    );
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('returns a fresh access token without any network call', async () => {
    storedRow = encryptedRow(buildConnection({ expires_at: nowSeconds() + 3600 }));

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'access_token',
      accessToken: 'stored-access-token',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('serves a still-valid token without refreshing before earliest_refresh_at', async () => {
    storedRow = encryptedRow(
      buildConnection({
        expires_at: nowSeconds() + 30,
        earliest_refresh_at: nowSeconds() + 300,
      })
    );

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'access_token',
      accessToken: 'stored-access-token',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes an expired token even when earliest_refresh_at is in the past', async () => {
    storedRow = encryptedRow(buildConnection({ earliest_refresh_at: nowSeconds() - 1 }));
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: 'new-access-token', expires_in: 3600 })
    );

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'access_token',
      accessToken: 'new-access-token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stores earliest_refresh_at returned by the refresh response', async () => {
    storedRow = encryptedRow(buildConnection());
    const earliestRefreshAt = nowSeconds() + 600;
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'new-access-token',
        expires_in: 3600,
        earliest_refresh_at: earliestRefreshAt,
      })
    );

    await resolveOpenAiChatGptAccessToken(USER_OWNER);

    expect(decodeStored(txUpdateSetCalls[0]).earliest_refresh_at).toBe(earliestRefreshAt);
  });

  it('reports no connection when no row is stored', async () => {
    storedRow = null;

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'no_connection',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refreshes an expired token, rotates the pair and persists it', async () => {
    storedRow = encryptedRow(buildConnection());
    fetchMock.mockResolvedValue(
      jsonResponse({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
        scope: 'openid',
        token_type: 'Bearer',
      })
    );

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'access_token',
      accessToken: 'new-access-token',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(OPENAI_TOKEN_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded'
    );
    expect((init.headers as Record<string, string>).Authorization).toBe(expectedBasicAuth());

    const body = new URLSearchParams(init.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('stored-refresh-token');
    expect(body.get('client_id')).toBe(OPENAI_CLIENT_ID);
    expect(body.get('resource')).toBe(OPENAI_RESOURCE);

    expect(txUpdateSetCalls).toHaveLength(1);
    const persisted = decodeStored(txUpdateSetCalls[0]);
    expect(persisted.access_token).toBe('new-access-token');
    expect(persisted.refresh_token).toBe('new-refresh-token');
    expect(persisted.status).toBe('connected');
    expect(persisted.expires_at).toBeGreaterThan(nowSeconds() + 3000);
    expect(txUpdateSetCalls[0].is_enabled).toBe(true);
  });

  it('keeps the previous refresh token when the response does not rotate it', async () => {
    storedRow = encryptedRow(buildConnection());
    fetchMock.mockResolvedValue(jsonResponse({ access_token: 'new-access-token', expires_in: 60 }));

    await resolveOpenAiChatGptAccessToken(USER_OWNER);

    const persisted = decodeStored(txUpdateSetCalls[0]);
    expect(persisted.refresh_token).toBe('stored-refresh-token');
  });

  it('retries a refresh_token_conflict and succeeds', async () => {
    storedRow = encryptedRow(buildConnection());
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'refresh_token_conflict' }, 409))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'new-access-token', expires_in: 3600 }));

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'access_token',
      accessToken: 'new-access-token',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(txUpdateSetCalls).toHaveLength(1);
  });

  it('waits for Retry-After before retrying a throttled refresh', async () => {
    storedRow = encryptedRow(buildConnection());
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429, { 'retry-after': '7' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'new-access-token', expires_in: 3600 }));

    const delays = captureRetryDelays();
    try {
      await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
        kind: 'access_token',
        accessToken: 'new-access-token',
      });
    } finally {
      delays.restore();
    }

    expect(delays.values).toContain(7000);
  });

  it('caps a Retry-After longer than the retry budget', async () => {
    storedRow = encryptedRow(buildConnection());
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429, { 'retry-after': '600' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'new-access-token', expires_in: 3600 }));

    const delays = captureRetryDelays();
    try {
      await resolveOpenAiChatGptAccessToken(USER_OWNER);
    } finally {
      delays.restore();
    }

    expect(delays.values).toContain(OPENAI_CHATGPT_REFRESH_MAX_BACKOFF_MS);
  });

  it('fails the request without clearing the tokens after the retries are exhausted', async () => {
    storedRow = encryptedRow(buildConnection());
    fetchMock.mockResolvedValue(jsonResponse({ error: 'refresh_token_conflict' }, 409));

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'failed',
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(txUpdateSetCalls).toHaveLength(0);
    expect(markUpdateSetCalls).toHaveLength(0);
  });

  it('releases the row lock between retry attempts', async () => {
    storedRow = encryptedRow(buildConnection());
    const events: string[] = [];
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      events.push('lock:acquire');
      try {
        return await callback({
          select: jest.fn(txSelectChain),
          update: jest.fn(() => ({
            set: jest.fn((values: Record<string, unknown>) => {
              txUpdateSetCalls.push(values);
              return { where: jest.fn(() => Promise.resolve(undefined)) };
            }),
          })),
        });
      } finally {
        events.push('lock:release');
      }
    });
    fetchMock.mockImplementation(async () => {
      events.push('fetch');
      return jsonResponse({ error: 'refresh_token_conflict' }, 409);
    });

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'failed',
    });

    // Every retry, and the backoff between them, happens with the row lock
    // released: the lock is taken for exactly one refresh request at a time.
    expect(events).toEqual([
      'lock:acquire',
      'fetch',
      'lock:release',
      'lock:acquire',
      'fetch',
      'lock:release',
      'lock:acquire',
      'fetch',
      'lock:release',
    ]);
  });

  it('adopts a token a concurrent refresh stored instead of retrying', async () => {
    storedRow = encryptedRow(buildConnection());
    fetchMock.mockImplementation(async () => {
      // A sibling instance rotated the pair and stored it while this attempt
      // was in flight; the next locked read must adopt that credential.
      storedRow = encryptedRow(
        buildConnection({
          access_token: 'sibling-access-token',
          refresh_token: 'sibling-refresh-token',
          expires_at: nowSeconds() + 3600,
        })
      );
      return jsonResponse({ error: 'refresh_token_conflict' }, 409);
    });

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'access_token',
      accessToken: 'sibling-access-token',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(txUpdateSetCalls).toHaveLength(0);
  });

  it('disables the connection with the reconnect message on invalid_grant', async () => {
    storedRow = encryptedRow(buildConnection());
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'terminal',
    });

    // One attempt only: a terminal error is not retried.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markUpdateSetCalls).toHaveLength(0);
    // The terminal write goes through the locked transaction, not a bare update.
    expect(txUpdateSetCalls).toHaveLength(1);
    expect(txUpdateSetCalls[0].is_enabled).toBe(false);
    const persisted = decodeStored(txUpdateSetCalls[0]);
    expect(persisted.status).toBe('error');
    expect(persisted.error_message).toBe(OPENAI_CHATGPT_RECONNECT_MESSAGE);
    // The dead credential is cleared, never kept at rest.
    expect(persisted.access_token).toBe('');
    expect(persisted.refresh_token).toBeUndefined();
    expect(persisted.expires_at).toBe(0);
  });

  it('writes the terminal state inside the row lock so a concurrent reconnect survives', async () => {
    storedRow = encryptedRow(buildConnection());
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));

    const events: string[] = [];
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      events.push('lock:acquire');
      try {
        return await callback({
          select: jest.fn(txSelectChain),
          update: jest.fn(() => ({
            set: jest.fn((values: Record<string, unknown>) => {
              events.push('terminal:write');
              txUpdateSetCalls.push(values);
              return { where: jest.fn(() => Promise.resolve(undefined)) };
            }),
          })),
        });
      } finally {
        events.push('lock:release');
      }
    });

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'terminal',
    });

    // The write happens before the lock is released, so a reconnect that saves a
    // new row cannot be overwritten by this stale failure.
    expect(events).toEqual(['lock:acquire', 'terminal:write', 'lock:release']);
    expect(markUpdateSetCalls).toHaveLength(0);
  });

  it('treats a disabled row as no connection and does not call OpenAI', async () => {
    storedRow = {
      ...encryptedRow(buildConnection({ expires_at: nowSeconds() + 3600 })),
      is_enabled: false,
    };

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'no_connection',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not call OpenAI when the stored connection has no refresh token', async () => {
    storedRow = encryptedRow(
      buildConnection({
        access_token: '',
        refresh_token: undefined,
        expires_at: 0,
        status: 'error',
      })
    );

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'terminal',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('issues exactly one fetch for two concurrent calls', async () => {
    storedRow = encryptedRow(buildConnection());
    let resolveFetch: (response: Response) => void = () => {};
    const deferred = new Promise<Response>(resolve => {
      resolveFetch = resolve;
    });
    fetchMock.mockImplementation(() => deferred);

    const first = resolveOpenAiChatGptAccessToken(USER_OWNER);
    const second = resolveOpenAiChatGptAccessToken(USER_OWNER);
    expect(second).toBe(first);

    resolveFetch(jsonResponse({ access_token: 'new-access-token', expires_in: 3600 }));

    await expect(first).resolves.toEqual({
      kind: 'access_token',
      accessToken: 'new-access-token',
    });
    await expect(second).resolves.toEqual({
      kind: 'access_token',
      accessToken: 'new-access-token',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never logs the client secret, the access token or the refresh token', async () => {
    storedRow = encryptedRow(buildConnection({ access_token: 'sensitive-access-token' }));
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
        kind: 'terminal',
      });
    } finally {
      errorSpy.mockRestore();
    }

    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain(OPENAI_CLIENT_SECRET);
    expect(logged).not.toContain('sensitive-access-token');
    expect(logged).not.toContain('stored-refresh-token');
  });
});

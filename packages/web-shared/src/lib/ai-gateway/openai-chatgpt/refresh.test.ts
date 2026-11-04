jest.mock('@kilocode/web-shared/lib/drizzle', () => {
  const db = {
    select: jest.fn(),
    transaction: jest.fn(),
    update: jest.fn(),
  };
  return { db, readDb: db };
});

jest.mock('@vercel/functions', () => ({
  ...jest.requireActual('@vercel/functions'),
  waitUntil: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  BYOK_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  OPENAI_CLIENT_ID: 'test-client-id',
  OPENAI_CLIENT_SECRET: 'super-secret-value',
}));

jest.mock('@kilocode/web-shared/lib/auth/openai/config', () => ({
  OPENAI_TOKEN_ENDPOINT: 'https://auth.openai.com/api/accounts/oauth/token',
  OPENAI_RESOURCE: 'https://api.openai.com/v1',
}));

import { db } from '@kilocode/web-shared/lib/drizzle';
import { waitUntil } from '@vercel/functions';
import { PgDialect } from 'drizzle-orm/pg-core';
import { encryptApiKey, decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import {
  BYOK_ENCRYPTION_KEY,
  OPENAI_CLIENT_ID,
  OPENAI_CLIENT_SECRET,
} from '@kilocode/web-shared/lib/config.server';
import {
  OPENAI_TOKEN_ENDPOINT,
  OPENAI_RESOURCE,
} from '@kilocode/web-shared/lib/auth/openai/config';
import {
  OPENAI_CHATGPT_RECONNECT_MESSAGE,
  OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS,
  OPENAI_CHATGPT_REFRESH_MAX_LOCK_BACKOFF_MS,
  OPENAI_CHATGPT_REFRESH_PERSISTENCE_GRACE_MS,
  OPENAI_CHATGPT_REFRESH_REQUEST_TIMEOUT_MS,
  OPENAI_CHATGPT_REFRESH_TIMEOUT_MS,
  resolveOpenAiChatGptAccessToken,
  type OpenAiChatGptAccessTokenOutcome,
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
  const setTimeout = global.setTimeout;
  const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((
    callback: () => void,
    delay?: number
  ) => {
    if (delay === OPENAI_CHATGPT_REFRESH_TIMEOUT_MS) return setTimeout(callback, delay);
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
  const txWriteTimeouts: string[] = [];
  const markUpdateSetCalls: Array<Record<string, unknown>> = [];
  const txRead = jest.fn();
  const txExecute = jest.fn();
  const txLock = jest.fn(() => ({ limit: txRead }));

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
        for: txLock,
      })),
    })),
  });

  beforeEach(() => {
    storedRow = null;
    txUpdateSetCalls.length = 0;
    txWriteTimeouts.length = 0;
    markUpdateSetCalls.length = 0;
    txRead.mockReset();
    txRead.mockImplementation(() => Promise.resolve(storedRow ? [storedRow] : []));
    txExecute.mockReset();
    txExecute.mockResolvedValue(undefined);
    txLock.mockClear();
    fetchMock.mockReset();
    jest.mocked(waitUntil).mockClear();
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
        execute: txExecute,
        select: jest.fn(txSelectChain),
        update: jest.fn(() => ({
          set: jest.fn((values: Record<string, unknown>) => {
            txUpdateSetCalls.push(values);
            const timeout = txExecute.mock.lastCall?.[0];
            if (timeout) txWriteTimeouts.push(new PgDialect().sqlToQuery(timeout).sql);
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
    expect(waitUntil).not.toHaveBeenCalled();
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

  it('refreshes an expired token even when earliest_refresh_at is still ahead', async () => {
    storedRow = encryptedRow(buildConnection({ earliest_refresh_at: nowSeconds() + 300 }));
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

  it('clears a stored earliest_refresh_at when the refresh response omits it', async () => {
    storedRow = encryptedRow(buildConnection({ earliest_refresh_at: nowSeconds() - 1 }));
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: 'new-access-token', expires_in: 3600 })
    );

    await resolveOpenAiChatGptAccessToken(USER_OWNER);

    expect(decodeStored(txUpdateSetCalls[0]).earliest_refresh_at).toBeUndefined();
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

  it('bounds Retry-After by the overall deadline without another request', async () => {
    jest.useFakeTimers();
    storedRow = encryptedRow(buildConnection());
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'rate_limited' }, 429, { 'retry-after': '600' }))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'new-access-token', expires_in: 3600 }));

    try {
      const pending = resolveOpenAiChatGptAccessToken(USER_OWNER);
      await jest.advanceTimersByTimeAsync(OPENAI_CHATGPT_REFRESH_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ kind: 'failed' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(txUpdateSetCalls).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('allows a slow transient response and healthy retry within the overall deadline', async () => {
    jest.useFakeTimers();
    storedRow = encryptedRow(buildConnection());
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise(resolve =>
            setTimeout(
              () => resolve(jsonResponse({ error: 'rate_limited' }, 429, { 'retry-after': '1' })),
              3000
            )
          )
      )
      .mockImplementationOnce(
        () =>
          new Promise(resolve =>
            setTimeout(
              () => resolve(jsonResponse({ access_token: 'new-access-token', expires_in: 3600 })),
              2500
            )
          )
      );
    try {
      const pending = resolveOpenAiChatGptAccessToken(USER_OWNER);
      await jest.advanceTimersByTimeAsync(6500);
      await expect(pending).resolves.toEqual({
        kind: 'access_token',
        accessToken: 'new-access-token',
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(txUpdateSetCalls).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
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
          execute: txExecute,
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

  it('re-reads a sibling token after a busy lock without holding another primary connection', async () => {
    jest.useFakeTimers();
    storedRow = encryptedRow(buildConnection());
    txRead.mockResolvedValueOnce([]);
    try {
      const pending = resolveOpenAiChatGptAccessToken(USER_OWNER);
      await jest.advanceTimersByTimeAsync(100);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(txLock).toHaveBeenCalledWith('update', { skipLocked: true });
      expect(fetchMock).not.toHaveBeenCalled();

      storedRow = encryptedRow(
        buildConnection({
          access_token: 'sibling-access-token',
          expires_at: nowSeconds() + 3600,
        })
      );
      await jest.advanceTimersByTimeAsync(400);
      await expect(pending).resolves.toEqual({
        kind: 'access_token',
        accessToken: 'sibling-access-token',
      });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(mockDb.select).toHaveBeenCalledTimes(2);
      expect(txUpdateSetCalls).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a busy lock when the replica still has the expired token', async () => {
    storedRow = encryptedRow(buildConnection());
    txRead.mockResolvedValueOnce([]);
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: 'new-access-token', expires_in: 3600 })
    );
    const delays = captureRetryDelays();
    try {
      await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
        kind: 'access_token',
        accessToken: 'new-access-token',
      });
      expect(mockDb.transaction).toHaveBeenCalledTimes(2);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      delays.restore();
    }
  });

  it.each([
    ['error', 'terminal'],
    ['connected', 'no_connection'],
  ] as const)(
    'preserves disabled sibling %s state observed by the replica',
    async (status, kind) => {
      jest.useFakeTimers();
      storedRow = encryptedRow(buildConnection());
      txRead.mockResolvedValueOnce([]);
      try {
        const pending = resolveOpenAiChatGptAccessToken(USER_OWNER);
        await jest.advanceTimersByTimeAsync(100);
        storedRow = {
          ...encryptedRow(
            buildConnection({ status, access_token: '', refresh_token: undefined, expires_at: 0 })
          ),
          is_enabled: false,
        };
        await jest.advanceTimersByTimeAsync(400);
        await expect(pending).resolves.toEqual({ kind });
        expect(mockDb.transaction).toHaveBeenCalledTimes(1);
        expect(mockDb.select).toHaveBeenCalledTimes(2);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(txUpdateSetCalls).toHaveLength(0);
      } finally {
        jest.useRealTimers();
      }
    }
  );

  it.each([
    ['error', 'terminal'],
    ['connected', 'no_connection'],
  ] as const)(
    'preserves disabled sibling %s state observed on the primary despite replica lag',
    async (status, kind) => {
      storedRow = encryptedRow(buildConnection());
      txRead.mockResolvedValueOnce([
        {
          ...encryptedRow(
            buildConnection({ status, access_token: '', refresh_token: undefined, expires_at: 0 })
          ),
          is_enabled: false,
        },
      ]);
      await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({ kind });
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(txUpdateSetCalls).toHaveLength(0);
    }
  );

  it.each([0, 0.99])(
    'bounds and jitters busy lock polling with randomness %s',
    async randomness => {
      jest.useFakeTimers();
      storedRow = encryptedRow(buildConnection());
      txRead.mockResolvedValue([]);
      const random = jest.spyOn(Math, 'random').mockReturnValue(randomness);
      const timers = jest.spyOn(global, 'setTimeout');
      try {
        const pending = resolveOpenAiChatGptAccessToken(USER_OWNER);
        await jest.advanceTimersByTimeAsync(OPENAI_CHATGPT_REFRESH_TIMEOUT_MS);
        await expect(pending).resolves.toEqual({ kind: 'failed' });
        expect(mockDb.transaction.mock.calls.length).toBeGreaterThan(3);
        expect(mockDb.transaction.mock.calls.length).toBeLessThanOrEqual(7);
        const delays = timers.mock.calls
          .map(([, delay]) => delay)
          .filter(
            (delay): delay is number =>
              typeof delay === 'number' && delay < OPENAI_CHATGPT_REFRESH_TIMEOUT_MS
          );
        const jitter = Math.floor(randomness * 250);
        expect(delays.slice(0, 3)).toEqual([250 + jitter, 500 + jitter, 1000 + jitter]);
        expect(delays.every(delay => delay <= OPENAI_CHATGPT_REFRESH_MAX_LOCK_BACKOFF_MS)).toBe(
          true
        );
        expect(fetchMock).not.toHaveBeenCalled();
        expect(txUpdateSetCalls).toHaveLength(0);
      } finally {
        timers.mockRestore();
        random.mockRestore();
        jest.useRealTimers();
      }
    }
  );

  it('keeps busy lock backoff separate from the network retry budget', async () => {
    storedRow = encryptedRow(buildConnection());
    for (let busy = 0; busy < 5; busy++) txRead.mockResolvedValueOnce([]);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'refresh_token_conflict' }, 409))
      .mockResolvedValueOnce(jsonResponse({ error: 'refresh_token_conflict' }, 409))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'new-access-token', expires_in: 3600 }));
    const random = jest.spyOn(Math, 'random').mockReturnValue(0);
    const delays = captureRetryDelays();
    try {
      await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
        kind: 'access_token',
        accessToken: 'new-access-token',
      });
      expect(mockDb.transaction).toHaveBeenCalledTimes(8);
      expect(fetchMock).toHaveBeenCalledTimes(OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS);
      expect(delays.values).toEqual([250, 500, 1000, 2000, 2000, 250, 500]);
    } finally {
      delays.restore();
      random.mockRestore();
    }
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

  it('treats the token_expired refresh failure as terminal', async () => {
    storedRow = encryptedRow(buildConnection());
    fetchMock.mockResolvedValue(jsonResponse({ error: 'token_expired' }, 400));

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'terminal',
    });

    // One attempt only: the code names an unusable refresh token, so the person
    // is told to reconnect instead of the request moving to another billing path.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('writes the terminal state inside the row lock so a concurrent reconnect survives', async () => {
    storedRow = encryptedRow(buildConnection());
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));

    const events: string[] = [];
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      events.push('lock:acquire');
      try {
        return await callback({
          execute: txExecute,
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

  it.each([
    ['success', 'access_token'],
    ['terminal', 'terminal'],
  ] as const)(
    'reduces the %s write statement timeout by time spent on HTTP',
    async (responseKind, kind) => {
      jest.useFakeTimers();
      storedRow = encryptedRow(buildConnection());
      const response =
        responseKind === 'success'
          ? jsonResponse({ access_token: 'new-access-token', expires_in: 3600 })
          : jsonResponse({ error: 'invalid_grant' }, 400);
      fetchMock.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve(response), 4900))
      );
      try {
        const pending = resolveOpenAiChatGptAccessToken(USER_OWNER);
        await jest.advanceTimersByTimeAsync(4900);
        expect((await pending).kind).toBe(kind);
        const writeBudget =
          3100 + (responseKind === 'success' ? OPENAI_CHATGPT_REFRESH_PERSISTENCE_GRACE_MS : 0);
        const writeTimeout = `SET LOCAL statement_timeout = '${writeBudget}'`;
        expect(
          txExecute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query).sql)
        ).toEqual([
          "SET LOCAL statement_timeout = '8000'",
          writeTimeout,
          ...(responseKind === 'success' ? [writeTimeout] : []),
        ]);
        expect(txWriteTimeouts).toEqual([writeTimeout]);
        expect(txUpdateSetCalls).toHaveLength(1);
      } finally {
        jest.useRealTimers();
      }
    }
  );

  it.each([
    ['configuration', 100],
    ['update', 100],
    ['commit', 100],
    ['configuration', 1100],
    ['update', 1100],
    ['commit', 1100],
  ] as const)(
    'commits accepted rotated tokens when %s completes %s ms after the caller deadline',
    async (stage, delayMs) => {
      jest.useFakeTimers();
      storedRow = encryptedRow(buildConnection());
      const blocked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const committed = Promise.withResolvers<void>();
      let didCommit = false;
      fetchMock.mockImplementation(
        () =>
          new Promise(resolve =>
            setTimeout(
              () =>
                resolve(
                  jsonResponse({
                    access_token: 'rotated-access-token',
                    refresh_token: 'rotated-refresh-token',
                    expires_in: 3600,
                  })
                ),
              4900
            )
          )
      );
      mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
        let pendingRow: StoredRow | null = null;
        const result = await callback({
          execute: async (...args: unknown[]) => {
            await txExecute(...args);
            if (stage === 'configuration' && txExecute.mock.calls.length === 2) {
              blocked.resolve();
              await release.promise;
            }
          },
          select: jest.fn(txSelectChain),
          update: () => ({
            set: (values: StoredRow) => ({
              where: async () => {
                pendingRow = values;
                if (stage === 'update') {
                  blocked.resolve();
                  await release.promise;
                }
              },
            }),
          }),
        });
        if (stage === 'commit') {
          blocked.resolve();
          await release.promise;
        }
        if (pendingRow) storedRow = pendingRow;
        didCommit = true;
        committed.resolve();
        return result;
      });
      try {
        const pending = resolveOpenAiChatGptAccessToken(USER_OWNER);
        await jest.advanceTimersByTimeAsync(4900);
        await blocked.promise;
        const retained = jest.mocked(waitUntil).mock.calls[0]?.[0];
        if (retained === undefined)
          throw new Error('Expected refresh cleanup to retain the request lifetime');
        const retainedFinished = jest.fn();
        void retained.then(retainedFinished);
        await jest.advanceTimersByTimeAsync(3100);
        await expect(pending).resolves.toEqual({ kind: 'failed' });
        expect(didCommit).toBe(false);
        expect(retainedFinished).not.toHaveBeenCalled();
        await jest.advanceTimersByTimeAsync(delayMs);
        expect(retainedFinished).not.toHaveBeenCalled();
        release.resolve();
        await jest.advanceTimersByTimeAsync(0);
        await committed.promise;
        await retained;
        expect(retainedFinished).toHaveBeenCalledTimes(1);
        const timeouts = txExecute.mock.calls.map(
          ([query]) => new PgDialect().sqlToQuery(query).sql
        );
        expect(timeouts[1]).toBe("SET LOCAL statement_timeout = '4100'");
        expect(timeouts[2]).toBe(
          `SET LOCAL statement_timeout = '${stage === 'commit' ? 4100 : 1000}'`
        );
        await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
          kind: 'access_token',
          accessToken: 'rotated-access-token',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(storedRow && decodeStored(storedRow).refresh_token).toBe('rotated-refresh-token');
      } finally {
        release.resolve();
        jest.useRealTimers();
      }
    }
  );

  it.each(['failed', 'timeout'])(
    'safely reports retained persistence %s without releasing it before database cleanup',
    async failure => {
      jest.useFakeTimers();
      storedRow = encryptedRow(buildConnection());
      const write = Promise.withResolvers<void>();
      const error = new Error(
        'sensitive stored-refresh-token super-secret-value rotated-refresh-token'
      );
      const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
      const timeouts = jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
        return controller.signal;
      });
      fetchMock.mockResolvedValue(
        jsonResponse({
          access_token: 'rotated-access-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 3600,
        })
      );
      mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) =>
        callback({
          execute: txExecute,
          select: jest.fn(txSelectChain),
          update: () => ({ set: () => ({ where: () => write.promise }) }),
        })
      );
      try {
        const pending = resolveOpenAiChatGptAccessToken(USER_OWNER);
        await jest.advanceTimersByTimeAsync(OPENAI_CHATGPT_REFRESH_TIMEOUT_MS);
        await expect(pending).resolves.toEqual({ kind: 'failed' });
        const retained = jest.mocked(waitUntil).mock.calls[0]?.[0];
        if (retained === undefined)
          throw new Error('Expected accepted persistence to retain request lifetime');
        if (failure === 'failed') {
          await jest.advanceTimersByTimeAsync(100);
          write.reject(error);
          await jest.advanceTimersByTimeAsync(0);
        } else {
          await jest.advanceTimersByTimeAsync(OPENAI_CHATGPT_REFRESH_PERSISTENCE_GRACE_MS);
          write.reject(error);
          await jest.advanceTimersByTimeAsync(0);
        }
        await retained;
        const logged = JSON.stringify(errors.mock.calls);
        expect(logged).toContain('persistence_failed');
        expect(logged).not.toContain('sensitive');
        expect(logged).not.toContain('stored-refresh-token');
        expect(logged).not.toContain('super-secret-value');
        expect(logged).not.toContain('rotated-refresh-token');
      } finally {
        write.reject(error);
        await jest.advanceTimersByTimeAsync(0);
        errors.mockRestore();
        timeouts.mockRestore();
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    }
  );

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

  it('sends the token request under the exported request budget', async () => {
    storedRow = encryptedRow(buildConnection());
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: 'new-access-token', expires_in: 3600 })
    );
    const timeouts = jest.spyOn(AbortSignal, 'timeout');
    const budgets = () => timeouts.mock.calls.map(([ms]) => ms);

    try {
      await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
        kind: 'access_token',
        accessToken: 'new-access-token',
      });
      expect(budgets()).toEqual([OPENAI_CHATGPT_REFRESH_REQUEST_TIMEOUT_MS]);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    } finally {
      timeouts.mockRestore();
    }
  });

  it('releases the row lock and retries each attempt its budget cuts off', async () => {
    storedRow = encryptedRow(buildConnection());
    const events: string[] = [];
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      events.push('lock:acquire');
      try {
        return await callback({
          execute: txExecute,
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

    // The endpoint accepts the connection and never answers, so the only thing
    // that can end a request is its own budget aborting it.
    const controllers: AbortController[] = [];
    const timeouts = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    fetchMock.mockImplementation(() => {
      events.push('fetch');
      controllers[controllers.length - 1].abort();
      return Promise.reject(new DOMException('The request was aborted.', 'TimeoutError'));
    });

    const delays = captureRetryDelays();
    let outcome: OpenAiChatGptAccessTokenOutcome;
    try {
      outcome = await resolveOpenAiChatGptAccessToken(USER_OWNER);
    } finally {
      delays.restore();
      timeouts.mockRestore();
    }

    expect(outcome).toEqual({ kind: 'failed' });
    // Every attempt was issued with its own budget, and the stall consumed all
    // of them before the outcome failed.
    expect(controllers).toHaveLength(OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS);
    // The row lock and the pool connection go back before the next attempt, so a
    // stalled endpoint cannot hold either across the retries.
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
    expect(delays.values).toHaveLength(OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS - 1);
    // A budget that runs out is transient: the stored credential stays as it is.
    expect(txUpdateSetCalls).toHaveLength(0);
    expect(markUpdateSetCalls).toHaveLength(0);
  });

  it('treats a body that outlives the request budget as a stall', async () => {
    storedRow = encryptedRow(buildConnection());
    const timeouts = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      // The budget ran out while the body was still arriving: the read yields
      // nothing, which must not be read as an OAuth answer.
      controller.abort();
      return controller.signal;
    });
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.reject(new DOMException('The request was aborted.', 'AbortError')),
      } as unknown as Response)
    );

    const delays = captureRetryDelays();
    let outcome: OpenAiChatGptAccessTokenOutcome;
    try {
      outcome = await resolveOpenAiChatGptAccessToken(USER_OWNER);
    } finally {
      delays.restore();
      timeouts.mockRestore();
    }

    expect(outcome).toEqual({ kind: 'failed' });
    expect(fetchMock).toHaveBeenCalledTimes(OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS);
    expect(txUpdateSetCalls).toHaveLength(0);
  });

  it.each(['headers', 'body'])(
    'bounds stalled %s across retries and ignores late success',
    async stage => {
      jest.useFakeTimers();
      storedRow = encryptedRow(buildConnection());
      const signals: AbortSignal[] = [];
      const lateResponses: Array<() => void> = [];
      const timeouts = jest.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), ms);
        return controller.signal;
      });
      fetchMock.mockImplementation((_url: string, init: RequestInit) => {
        if (!init.signal) throw new Error('Expected a cancellable token request');
        signals.push(init.signal);
        const successfulBody = { access_token: 'late-access-token', expires_in: 3600 };
        if (stage === 'headers') {
          return new Promise<Response>(resolve => {
            lateResponses.push(() => resolve(jsonResponse(successfulBody)));
          });
        }
        return Promise.resolve({
          ...jsonResponse(null),
          json: () =>
            new Promise(resolve => {
              lateResponses.push(() => resolve(successfulBody));
            }),
        });
      });
      try {
        const pending = resolveOpenAiChatGptAccessToken(USER_OWNER);
        await jest.advanceTimersByTimeAsync(OPENAI_CHATGPT_REFRESH_TIMEOUT_MS - 1);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await jest.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toEqual({ kind: 'failed' });
        expect(signals.every(signal => signal.aborted)).toBe(true);
        expect(txUpdateSetCalls).toHaveLength(0);

        storedRow = {
          ...encryptedRow(buildConnection({ status: 'error', access_token: '', expires_at: 0 })),
          is_enabled: false,
        };
        for (const respond of lateResponses) respond();
        await jest.advanceTimersByTimeAsync(0);
        expect(txUpdateSetCalls).toHaveLength(0);
        await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
          kind: 'terminal',
        });
      } finally {
        timeouts.mockRestore();
        jest.clearAllTimers();
        jest.useRealTimers();
      }
    }
  );

  it('includes a stalled replica read in the deadline and never starts late primary work', async () => {
    jest.useFakeTimers();
    const read = Promise.withResolvers<StoredRow[]>();
    mockDb.select.mockReturnValue({
      from: () => ({ where: () => ({ limit: () => read.promise }) }),
    });
    try {
      const pending = resolveOpenAiChatGptAccessToken(USER_OWNER);
      await jest.advanceTimersByTimeAsync(OPENAI_CHATGPT_REFRESH_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ kind: 'failed' });
      read.resolve([encryptedRow(buildConnection())]);
      await jest.advanceTimersByTimeAsync(0);
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not refresh when a queued primary connection arrives after the deadline', async () => {
    jest.useFakeTimers();
    storedRow = encryptedRow(buildConnection());
    const acquired = Promise.withResolvers<void>();
    const transaction = mockDb.transaction.getMockImplementation();
    mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
      await acquired.promise;
      return transaction?.(callback);
    });
    try {
      const pending = resolveOpenAiChatGptAccessToken(USER_OWNER);
      await jest.advanceTimersByTimeAsync(OPENAI_CHATGPT_REFRESH_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ kind: 'failed' });
      acquired.resolve();
      await jest.advanceTimersByTimeAsync(0);
      expect(txExecute).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(txUpdateSetCalls).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
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

jest.mock('@kilocode/web-shared/lib/drizzle', () => {
  const db = {
    select: jest.fn(),
    transaction: jest.fn(),
    update: jest.fn(),
  };
  return { db, readDb: db };
});

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
import type { OpenAiChatGptConnectionEnvelope } from '@kilocode/db/schema-types';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { OPENAI_CLIENT_ID, OPENAI_CLIENT_SECRET } from '@kilocode/web-shared/lib/config.server';
import {
  fetchWithFakeByokKms,
  TEST_BYOK_DATA_KEY,
  useFakeByokKms,
} from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { sealedOpenAiChatGptConnectionColumns } from '@kilocode/web-shared/tests/helpers/openai-chatgpt-connection.helper';
import {
  OPENAI_TOKEN_ENDPOINT,
  OPENAI_RESOURCE,
} from '@kilocode/web-shared/lib/auth/openai/config';
import {
  OPENAI_CHATGPT_RECONNECT_MESSAGE,
  OPENAI_CHATGPT_REFRESH_MAX_BACKOFF_MS,
  OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS,
  OPENAI_CHATGPT_REFRESH_REQUEST_TIMEOUT_MS,
  resolveOpenAiChatGptAccessToken,
  type OpenAiChatGptAccessTokenOutcome,
} from './refresh';
import { decryptOpenAiChatGptConnection, type OpenAiChatGptOwner } from './store';
import { OpenAiChatGptConnectionSchema, type OpenAiChatGptConnection } from './types';

type MockDb = {
  select: jest.Mock;
  transaction: jest.Mock;
  update: jest.Mock;
};

type StoredRow = {
  kilo_user_id: string;
  organization_id: string | null;
  is_shared_services: boolean;
  encrypted_connection_envelope: OpenAiChatGptConnectionEnvelope | null;
  is_enabled: boolean;
};

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
    kilo_user_id: TEST_USER_ID,
    organization_id: null,
    is_shared_services: false,
    ...sealedOpenAiChatGptConnectionColumns(connection),
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

/** The payload a write stored in its envelope. */
function decodeStored(setCall: Record<string, unknown>): OpenAiChatGptConnection {
  const envelope = setCall.encrypted_connection_envelope as OpenAiChatGptConnectionEnvelope;
  return OpenAiChatGptConnectionSchema.parse(
    JSON.parse(decryptApiKey(envelope.encrypted_data, TEST_BYOK_DATA_KEY))
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
  const kms = useFakeByokKms();

  let storedRow: StoredRow | null = null;
  // Set to make the replica read in the fast path differ from the locked read of `storedRow`.
  let replicaOverride: StoredRow | null | undefined;
  const txUpdateSetCalls: Array<Record<string, unknown>> = [];
  const markUpdateSetCalls: Array<Record<string, unknown>> = [];

  const selectChain = () => ({
    from: jest.fn(() => ({
      where: jest.fn(() => ({
        limit: jest.fn(() => {
          const row = replicaOverride === undefined ? storedRow : replicaOverride;
          return Promise.resolve(row ? [row] : []);
        }),
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
    replicaOverride = undefined;
    txUpdateSetCalls.length = 0;
    markUpdateSetCalls.length = 0;
    fetchMock.mockReset();
    global.fetch = fetchWithFakeByokKms(
      OPENAI_TOKEN_ENDPOINT,
      fetchMock as unknown as typeof fetch
    );

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

  it('returns a fresh access token without any network call', async () => {
    storedRow = encryptedRow(buildConnection({ expires_at: nowSeconds() + 3600 }));

    await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
      kind: 'access_token',
      accessToken: 'stored-access-token',
      credentialKeyId: storedRow.encrypted_connection_envelope?.key_id,
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
      credentialKeyId: expect.any(String),
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
      credentialKeyId: expect.any(String),
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
      credentialKeyId: expect.any(String),
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
      credentialKeyId: expect.any(String),
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
        credentialKeyId: expect.any(String),
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
      credentialKeyId: expect.any(String),
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
      credentialKeyId: expect.any(String),
    });
    await expect(second).resolves.toEqual({
      kind: 'access_token',
      accessToken: 'new-access-token',
      credentialKeyId: expect.any(String),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the token request under the exported request budget', async () => {
    storedRow = encryptedRow(buildConnection());
    fetchMock.mockResolvedValue(
      jsonResponse({ access_token: 'new-access-token', expires_in: 3600 })
    );
    const timeouts = jest.spyOn(AbortSignal, 'timeout');

    try {
      await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
        kind: 'access_token',
        accessToken: 'new-access-token',
        credentialKeyId: expect.any(String),
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
      // The KMS client also creates timeout signals, so find the one the token request carries.
      const budgetIndex = timeouts.mock.results.findIndex(result => result.value === init.signal);
      expect(timeouts.mock.calls[budgetIndex]?.[0]).toBe(OPENAI_CHATGPT_REFRESH_REQUEST_TIMEOUT_MS);
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
    const controllers = new Map<AbortSignal | null | undefined, AbortController>();
    const timeouts = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      controllers.set(controller.signal, controller);
      return controller.signal;
    });
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      events.push('fetch');
      controllers.get(init.signal)?.abort();
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
    const signals = fetchMock.mock.calls.map(([, init]) => (init as RequestInit).signal);
    expect(signals).toHaveLength(OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS);
    expect(new Set(signals).size).toBe(OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS);
    expect(signals.every(signal => signal?.aborted)).toBe(true);
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
    // The KMS data key cache's Redis client also schedules timers; only the backoff delays are positive.
    expect(delays.values.filter(delay => delay > 0)).toHaveLength(
      OPENAI_CHATGPT_REFRESH_MAX_ATTEMPTS - 1
    );
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

  it('never logs the client secret, the access token or the refresh token', async () => {
    storedRow = encryptedRow(buildConnection({ access_token: 'sensitive-access-token' }));
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let logged: string;

    try {
      await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
        kind: 'terminal',
      });
      logged = JSON.stringify(errorSpy.mock.calls);
    } finally {
      errorSpy.mockRestore();
    }

    expect(logged).not.toContain(OPENAI_CLIENT_SECRET);
    expect(logged).not.toContain('sensitive-access-token');
    expect(logged).not.toContain('stored-refresh-token');
  });

  describe('with KMS envelopes', () => {
    const connectionOf = (row: StoredRow) => decryptOpenAiChatGptConnection(row);

    /** Resolves a refresh that must fail and returns everything it logged to `console.error`. */
    async function resolveFailedAndCaptureLogs(): Promise<string> {
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
          kind: 'failed',
        });
        return JSON.stringify(errorSpy.mock.calls);
      } finally {
        errorSpy.mockRestore();
      }
    }

    it('stores a rotated token set in the envelope and reads the new refresh token from the envelope', async () => {
      storedRow = encryptedRow(buildConnection());
      fetchMock.mockResolvedValue(
        jsonResponse({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: 3600,
        })
      );

      await resolveOpenAiChatGptAccessToken(USER_OWNER);

      const [written] = txUpdateSetCalls;
      expect(decodeStored(written).refresh_token).toBe('new-refresh-token');
      expect(JSON.stringify(written)).not.toContain('new-refresh-token');
      const envelope = written.encrypted_connection_envelope as OpenAiChatGptConnectionEnvelope;
      expect(envelope.key_id).toEqual(expect.any(String));
      kms.requests.length = 0;
      await expect(
        connectionOf({ ...(storedRow as StoredRow), ...written } as StoredRow)
      ).resolves.toMatchObject({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
      });
      expect(kms.requests).toEqual([
        {
          path: '/decrypt',
          body: expect.objectContaining({
            key_id: envelope.key_id,
            owner_type: 'user',
            owner_id: TEST_USER_ID,
            provider_id: 'openai-chatgpt-oauth:personal',
          }),
        },
      ]);
    });

    it('creates one data key for the refresh actor before the row lock, whatever the attempts', async () => {
      storedRow = encryptedRow(buildConnection());
      const events: string[] = [];
      mockDb.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
        events.push(`lock:acquire after ${kms.requests.map(request => request.path).join(',')}`);
        return callback({
          select: jest.fn(txSelectChain),
          update: jest.fn(() => ({
            set: jest.fn((values: Record<string, unknown>) => {
              txUpdateSetCalls.push(values);
              return { where: jest.fn(() => Promise.resolve(undefined)) };
            }),
          })),
        });
      });
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: 'refresh_token_conflict' }, 409))
        .mockResolvedValueOnce(
          jsonResponse({ access_token: 'new-access-token', expires_in: 3600 })
        );
      const delays = captureRetryDelays();

      try {
        await resolveOpenAiChatGptAccessToken(USER_OWNER);
      } finally {
        delays.restore();
      }

      const dataKeyRequests = kms.requests.filter(request => request.path === '/data-key');
      expect(dataKeyRequests).toHaveLength(1);
      expect(dataKeyRequests[0].body).toMatchObject({
        owner_type: 'user',
        owner_id: TEST_USER_ID,
        provider_id: 'openai-chatgpt-oauth:personal',
        actor_user_id: 'system:openai-chatgpt-refresh',
      });
      expect(events[0]).toContain('/data-key');
      expect(
        (txUpdateSetCalls[0].encrypted_connection_envelope as OpenAiChatGptConnectionEnvelope)
          .key_id
      ).toBe(dataKeyRequests[0].body.key_id);
    });

    it('writes the terminal error state into the envelope', async () => {
      storedRow = encryptedRow(buildConnection());
      fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, 400));

      await resolveOpenAiChatGptAccessToken(USER_OWNER);

      const [written] = txUpdateSetCalls;
      expect(decodeStored(written)).toMatchObject({
        status: 'error',
        access_token: '',
        error_message: OPENAI_CHATGPT_RECONNECT_MESSAGE,
      });
      expect(JSON.stringify(written)).not.toContain('stored-refresh-token');
      expect(written.is_enabled).toBe(false);
    });

    it('refreshes with the envelope refresh token', async () => {
      storedRow = encryptedRow(
        buildConnection({ access_token: 'envelope-access', refresh_token: 'envelope-refresh' })
      );
      fetchMock.mockResolvedValue(
        jsonResponse({ access_token: 'new-access-token', expires_in: 60 })
      );

      await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
        kind: 'access_token',
        accessToken: 'new-access-token',
        credentialKeyId: expect.any(String),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(new URLSearchParams(init.body as string).get('refresh_token')).toBe(
        'envelope-refresh'
      );
      expect(decodeStored(txUpdateSetCalls[0]).refresh_token).toBe('envelope-refresh');
    });

    it('serves the access token of the envelope', async () => {
      storedRow = encryptedRow(
        buildConnection({ access_token: 'envelope-access', expires_at: nowSeconds() + 3600 })
      );

      await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
        kind: 'access_token',
        accessToken: 'envelope-access',
        credentialKeyId: expect.any(String),
      });
    });

    it('reports no connection for a row without an envelope', async () => {
      storedRow = {
        ...encryptedRow(buildConnection({ expires_at: nowSeconds() + 3600 })),
        encrypted_connection_envelope: null,
      };

      await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
        kind: 'no_connection',
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(txUpdateSetCalls).toHaveLength(0);
    });

    it('fails without calling OpenAI or writing when the KMS service cannot create a data key', async () => {
      storedRow = encryptedRow(buildConnection());
      kms.fail('/data-key');
      const logged = await resolveFailedAndCaptureLogs();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockDb.transaction).not.toHaveBeenCalled();
      expect(txUpdateSetCalls).toHaveLength(0);
      expect(markUpdateSetCalls).toHaveLength(0);
      expect(logged).toContain('kms_unavailable');
      expect(logged).not.toContain('stored-refresh-token');
    });

    it('fails without calling OpenAI when the KMS service issues a data key that cannot encrypt', async () => {
      storedRow = encryptedRow(buildConnection());
      // Non-empty, so the KMS client accepts it, but not a 32-byte AES key.
      kms.issueDataKey(Buffer.alloc(8, 1).toString('base64'));
      const logged = await resolveFailedAndCaptureLogs();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(txUpdateSetCalls).toHaveLength(0);
      expect(markUpdateSetCalls).toHaveLength(0);
      expect(logged).toContain('kms_unavailable');
    });

    it('fails without calling OpenAI when the data key is first needed inside the lock and the KMS service refuses it', async () => {
      storedRow = encryptedRow(buildConnection());
      // The replica has not shown the row yet, so no data key was created before the lock.
      replicaOverride = null;
      kms.fail('/data-key');
      const logged = await resolveFailedAndCaptureLogs();

      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(txUpdateSetCalls).toHaveLength(0);
      expect(logged).toContain('kms_unavailable');
    });

    it('creates the data key inside the lock when only the primary shows the row', async () => {
      storedRow = encryptedRow(buildConnection());
      replicaOverride = null;
      fetchMock.mockResolvedValue(
        jsonResponse({ access_token: 'new-access-token', expires_in: 60 })
      );

      await expect(resolveOpenAiChatGptAccessToken(USER_OWNER)).resolves.toEqual({
        kind: 'access_token',
        accessToken: 'new-access-token',
        credentialKeyId: expect.any(String),
      });

      expect(kms.requests.filter(request => request.path === '/data-key')).toHaveLength(1);
      expect(decodeStored(txUpdateSetCalls[0]).access_token).toBe('new-access-token');
    });

    it('fails without calling OpenAI or writing when the KMS service refuses to decrypt the stored payload', async () => {
      storedRow = encryptedRow(buildConnection());
      kms.fail('/decrypt');
      const logged = await resolveFailedAndCaptureLogs();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(txUpdateSetCalls).toHaveLength(0);
      expect(markUpdateSetCalls).toHaveLength(0);
      expect(logged).not.toContain('stored-refresh-token');
    });

    it('fails without calling OpenAI when only the locked read needs the KMS service to decrypt and it refuses', async () => {
      storedRow = encryptedRow(buildConnection());
      replicaOverride = null;
      kms.fail('/decrypt');
      await resolveFailedAndCaptureLogs();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(txUpdateSetCalls).toHaveLength(0);
    });
  });
});

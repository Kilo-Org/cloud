jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  BYOK_ENCRYPTION_KEY: process.env.BYOK_ENCRYPTION_KEY,
  OPENAI_CLIENT_ID: 'test-client-id',
  OPENAI_CLIENT_SECRET: 'test-client-secret',
}));

import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { openai_chatgpt_connections } from '@kilocode/db/schema';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_ENCRYPTION_KEY } from '@kilocode/web-shared/lib/config.server';
import { OPENAI_CHATGPT_RECONNECT_MESSAGE, resolveOpenAiChatGptAccessToken } from './refresh';
import {
  getOpenAiChatGptStoredConnection,
  openAiChatGptOwnerWhere,
  readOpenAiChatGptConnectionRow,
  saveOpenAiChatGptConnection,
  type OpenAiChatGptOwner,
} from './store';
import type { OpenAiChatGptConnection } from './types';

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function connection(overrides: Partial<OpenAiChatGptConnection> = {}): OpenAiChatGptConnection {
  return {
    access_token: 'stale-access-token',
    refresh_token: 'stale-refresh-token',
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

const TERMINAL_REFRESH_RESPONSE = {
  ok: false,
  status: 400,
  headers: new Headers(),
  json: async () => ({ error: 'invalid_grant' }),
} as unknown as Response;

describe('terminal refresh failure against a real database', () => {
  let owner: OpenAiChatGptOwner;
  const fetchMock = jest.fn();
  const originalFetch = global.fetch;

  beforeAll(async () => {
    const user = await insertTestUser({
      google_user_email: `chatgpt-refresh-terminal-${randomUUID()}@example.com`,
    });
    owner = { kiloUserId: user.id, organizationId: null };
  });

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('disables and clears the connection whose refresh token OpenAI rejected', async () => {
    await saveOpenAiChatGptConnection(owner, connection(), owner.kiloUserId as string);
    fetchMock.mockResolvedValue(TERMINAL_REFRESH_RESPONSE);

    await expect(resolveOpenAiChatGptAccessToken(owner)).resolves.toEqual({ kind: 'terminal' });

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = request.body;
    if (typeof body !== 'string') throw new Error('expected a form-encoded refresh request body');
    expect(new URLSearchParams(body).get('refresh_token')).toBe('stale-refresh-token');

    const stored = await getOpenAiChatGptStoredConnection(owner);
    expect(stored?.isEnabled).toBe(false);
    expect(stored?.connection.access_token).toBe('');
    expect(stored?.connection.refresh_token).toBeUndefined();
    expect(stored?.connection.status).toBe('error');
    expect(stored?.connection.error_message).toBe(OPENAI_CHATGPT_RECONNECT_MESSAGE);
  });

  it('does not erase a connection reconnected while the failing refresh held the row lock', async () => {
    await saveOpenAiChatGptConnection(owner, connection(), owner.kiloUserId as string);

    const fetchGate = Promise.withResolvers<void>();
    const fetchCalled = Promise.withResolvers<void>();

    // The token exchange runs inside the transaction that holds the row lock.
    // Parking it there keeps the lock held while the reconnect below is issued.
    fetchMock.mockImplementation(async () => {
      fetchCalled.resolve();
      await fetchGate.promise;
      return TERMINAL_REFRESH_RESPONSE;
    });

    const refresh = resolveOpenAiChatGptAccessToken(owner);
    await fetchCalled.promise;

    let reconnected = false;
    const reconnect = saveOpenAiChatGptConnection(
      owner,
      connection({
        access_token: 'reconnected-access-token',
        refresh_token: 'reconnected-refresh-token',
        expires_at: nowSeconds() + 3600,
      }),
      owner.kiloUserId as string
    ).then(() => {
      reconnected = true;
    });

    // A blocked row-lock wait exposes no promise to await, and deterministic
    // time control cannot apply to a real Postgres lock, so this one bounded
    // wait observes the wait state directly. The lock holds it well past this.
    await new Promise(resolve => setTimeout(resolve, 250));
    // The row lock keeps the reconnect from landing between the failing request
    // and the terminal write, so the write cannot erase it.
    expect(reconnected).toBe(false);

    fetchGate.resolve();
    await expect(refresh).resolves.toEqual({ kind: 'terminal' });
    await reconnect;

    const stored = await getOpenAiChatGptStoredConnection(owner);
    expect(stored?.isEnabled).toBe(true);
    expect(stored?.connection).toMatchObject({
      access_token: 'reconnected-access-token',
      refresh_token: 'reconnected-refresh-token',
      status: 'connected',
    });
  });

  it('adopts a sibling refresh after skipping its busy row lock', async () => {
    await saveOpenAiChatGptConnection(owner, connection(), owner.kiloUserId as string);
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const siblingConnection = connection({
      access_token: 'sibling-access-token',
      refresh_token: 'sibling-refresh-token',
      expires_at: nowSeconds() + 3600,
    });
    const sibling = db.transaction(async tx => {
      await readOpenAiChatGptConnectionRow(tx, owner, { forUpdate: true });
      locked.resolve();
      await release.promise;
      await tx
        .update(openai_chatgpt_connections)
        .set({
          encrypted_connection: encryptApiKey(
            JSON.stringify(siblingConnection),
            BYOK_ENCRYPTION_KEY
          ),
          is_enabled: true,
        })
        .where(openAiChatGptOwnerWhere(owner));
    });
    await locked.promise;
    const refresh = resolveOpenAiChatGptAccessToken(owner);
    try {
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await sibling;
    }
    await expect(refresh).resolves.toEqual({
      kind: 'access_token',
      accessToken: 'sibling-access-token',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await getOpenAiChatGptStoredConnection(owner))?.connection.refresh_token).toBe(
      'sibling-refresh-token'
    );
  });

  it('cannot clear a terminal state when an aborted refresh later succeeds', async () => {
    await saveOpenAiChatGptConnection(owner, connection(), owner.kiloUserId as string);
    const called = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Response>();
    const controllers: AbortController[] = [];
    const timeouts = jest.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    fetchMock
      .mockImplementationOnce(() => {
        called.resolve();
        return late.promise;
      })
      .mockResolvedValue(TERMINAL_REFRESH_RESPONSE);
    try {
      const refresh = resolveOpenAiChatGptAccessToken(owner);
      await called.promise;
      controllers[0].abort();
      await expect(refresh).resolves.toEqual({ kind: 'terminal' });
      late.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({
          access_token: 'late-access-token',
          refresh_token: 'late-refresh-token',
          expires_in: 3600,
        }),
      } as unknown as Response);
      await new Promise(resolve => setImmediate(resolve));
      const stored = await getOpenAiChatGptStoredConnection(owner);
      expect(stored?.isEnabled).toBe(false);
      expect(stored?.connection.status).toBe('error');
      expect(stored?.connection.access_token).toBe('');
      expect(stored?.connection.refresh_token).toBeUndefined();
    } finally {
      timeouts.mockRestore();
    }
  });
});

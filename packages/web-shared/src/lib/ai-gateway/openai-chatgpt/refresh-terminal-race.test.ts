jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  BYOK_ENCRYPTION_KEY: process.env.BYOK_ENCRYPTION_KEY,
  OPENAI_CLIENT_ID: 'test-client-id',
  OPENAI_CLIENT_SECRET: 'test-client-secret',
}));

import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import {
  fetchWithFakeByokKms,
  useFakeByokKms,
} from '@kilocode/web-shared/tests/helpers/byok-kms.helper';
import { OPENAI_TOKEN_ENDPOINT } from '@kilocode/web-shared/lib/auth/openai/config';
import { and, eq, isNull } from 'drizzle-orm';
import { openai_chatgpt_connections } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { OBSOLETE_STATIC_KEY_PLACEHOLDER } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-credential';
import { staticKeyOpenAiChatGptConnection } from '@kilocode/web-shared/tests/helpers/openai-chatgpt-connection.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { OPENAI_CHATGPT_RECONNECT_MESSAGE, resolveOpenAiChatGptAccessToken } from './refresh';
import {
  getOpenAiChatGptStoredConnection,
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
  useFakeByokKms();

  beforeAll(async () => {
    const user = await insertTestUser({
      google_user_email: `chatgpt-refresh-terminal-${randomUUID()}@example.com`,
    });
    owner = { kiloUserId: user.id, organizationId: null };
  });

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchWithFakeByokKms(
      OPENAI_TOKEN_ENDPOINT,
      fetchMock as unknown as typeof fetch
    );
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
});

describe('refresh with KMS envelopes against a real database', () => {
  let owner: OpenAiChatGptOwner;
  const fetchMock = jest.fn();
  const kms = useFakeByokKms();

  const personalRowWhere = () =>
    and(
      eq(openai_chatgpt_connections.kilo_user_id, owner.kiloUserId as string),
      isNull(openai_chatgpt_connections.organization_id)
    );

  async function readRow() {
    const [row] = await db
      .select({
        obsolete: openai_chatgpt_connections.encrypted_connection,
        envelope: openai_chatgpt_connections.encrypted_connection_envelope,
        isEnabled: openai_chatgpt_connections.is_enabled,
      })
      .from(openai_chatgpt_connections)
      .where(personalRowWhere());
    return row;
  }

  function refreshTokenSent(): string | null {
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    return new URLSearchParams(init.body as string).get('refresh_token');
  }

  beforeAll(async () => {
    const user = await insertTestUser({
      google_user_email: `chatgpt-refresh-kms-${randomUUID()}@example.com`,
    });
    owner = { kiloUserId: user.id, organizationId: null };
  });

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchWithFakeByokKms(
      OPENAI_TOKEN_ENDPOINT,
      fetchMock as unknown as typeof fetch
    );
  });

  it('rotates the tokens into a new envelope and keeps the placeholder in the obsolete column', async () => {
    await saveOpenAiChatGptConnection(owner, connection(), owner.kiloUserId as string);
    fetchMock.mockResolvedValue(
      Response.json({
        access_token: 'rotated-access-token',
        refresh_token: 'rotated-refresh-token',
        expires_in: 3600,
      })
    );
    const before = await readRow();

    const outcome = await resolveOpenAiChatGptAccessToken(owner);

    const after = await readRow();
    // The outcome names the credential it just stored, so a refusal of it can be matched.
    expect(outcome).toEqual({
      kind: 'access_token',
      accessToken: 'rotated-access-token',
      credentialKeyId: after.envelope?.key_id,
    });
    expect(after.envelope?.key_id).not.toBe(before.envelope?.key_id);
    expect(after.obsolete).toEqual(OBSOLETE_STATIC_KEY_PLACEHOLDER);
    expect(JSON.stringify(after.envelope)).not.toContain('rotated');
    const dataKeyRequests = kms.requests.filter(request => request.path === '/data-key');
    expect(dataKeyRequests.at(-1)?.body).toMatchObject({
      actor_user_id: 'system:openai-chatgpt-refresh',
      key_id: after.envelope?.key_id,
    });
    await expect(getOpenAiChatGptStoredConnection(owner)).resolves.toMatchObject({
      connection: { refresh_token: 'rotated-refresh-token' },
    });
  });

  it('refreshes with the envelope refresh token, never the one in the obsolete static-key column', async () => {
    await saveOpenAiChatGptConnection(
      owner,
      connection({ refresh_token: 'envelope-refresh-token' }),
      owner.kiloUserId as string
    );
    await db
      .update(openai_chatgpt_connections)
      .set({
        encrypted_connection: staticKeyOpenAiChatGptConnection(
          connection({ refresh_token: 'static-refresh-token' })
        ),
      })
      .where(personalRowWhere());
    fetchMock.mockResolvedValue(
      Response.json({ access_token: 'new-access-token', expires_in: 60 })
    );

    await expect(resolveOpenAiChatGptAccessToken(owner)).resolves.toEqual({
      kind: 'access_token',
      accessToken: 'new-access-token',
      credentialKeyId: expect.any(String),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refreshTokenSent()).toBe('envelope-refresh-token');
    const after = await readRow();
    expect(after.obsolete).toEqual(OBSOLETE_STATIC_KEY_PLACEHOLDER);
    await expect(getOpenAiChatGptStoredConnection(owner)).resolves.toMatchObject({
      connection: { refresh_token: 'envelope-refresh-token', access_token: 'new-access-token' },
    });
  });

  it('fails without contacting OpenAI and leaves the row alone when no data key can be created', async () => {
    await saveOpenAiChatGptConnection(owner, connection(), owner.kiloUserId as string);
    const before = await readRow();
    kms.fail('/data-key');

    await expect(resolveOpenAiChatGptAccessToken(owner)).resolves.toEqual({ kind: 'failed' });

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readRow()).resolves.toEqual(before);
  });

  it('fails without contacting OpenAI and leaves the row alone when the stored payload cannot be decrypted', async () => {
    await saveOpenAiChatGptConnection(owner, connection(), owner.kiloUserId as string);
    const before = await readRow();
    kms.fail('/decrypt');

    await expect(resolveOpenAiChatGptAccessToken(owner)).resolves.toEqual({ kind: 'failed' });

    expect(fetchMock).not.toHaveBeenCalled();
    await expect(readRow()).resolves.toEqual(before);
  });

  it('writes the terminal error state into the envelope and the placeholder into the obsolete column', async () => {
    await saveOpenAiChatGptConnection(owner, connection(), owner.kiloUserId as string);
    fetchMock.mockResolvedValue(TERMINAL_REFRESH_RESPONSE);

    await expect(resolveOpenAiChatGptAccessToken(owner)).resolves.toEqual({ kind: 'terminal' });

    const row = await readRow();
    expect(row.isEnabled).toBe(false);
    expect(row.obsolete).toEqual(OBSOLETE_STATIC_KEY_PLACEHOLDER);
    expect(JSON.stringify(row.envelope)).not.toContain('stale-refresh-token');
    await expect(getOpenAiChatGptStoredConnection(owner)).resolves.toMatchObject({
      isEnabled: false,
      connection: { status: 'error', access_token: '' },
    });
  });
});

// The store mock must be registered before the router is loaded: this suite
// runs against the mocked connection store, never against the database.
jest.mock('@/lib/ai-gateway/openai-chatgpt/store', () => ({
  getOpenAiChatGptConnection: jest.fn(),
  clearOpenAiChatGptConnection: jest.fn(),
  readOpenAiChatGptUsageLimit: jest.fn(),
}));

jest.mock('@/routers/organizations/utils', () => {
  const actual = jest.requireActual('@/routers/organizations/utils') as Record<string, unknown>;
  return { ...actual, ensureOrganizationAccess: jest.fn() };
});

import { beforeEach, describe, expect, it } from '@jest/globals';
import { createCallerFactory } from '@/lib/trpc/init';
import { rootRouter } from '@/routers/root-router';
import {
  clearOpenAiChatGptConnection,
  getOpenAiChatGptConnection,
  readOpenAiChatGptUsageLimit,
  type OpenAiChatGptOwner,
} from '@/lib/ai-gateway/openai-chatgpt/store';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import type { OpenAiChatGptConnection } from '@/lib/ai-gateway/openai-chatgpt/types';

const createCaller = createCallerFactory(rootRouter);

const USER_ID = 'user-1';
const ORG_ID = '00000000-0000-4000-8000-000000000001';
const USER_OWNER: OpenAiChatGptOwner = { kiloUserId: USER_ID, organizationId: null };
const ORG_OWNER: OpenAiChatGptOwner = { kiloUserId: USER_ID, organizationId: ORG_ID };
const CONNECTED_AT = '2026-09-16T12:00:00.000Z';
const RECONNECT_MESSAGE = 'Your ChatGPT connection has expired. Reconnect to continue.';

function connectedConnection(
  overrides: Partial<OpenAiChatGptConnection> = {}
): OpenAiChatGptConnection {
  return {
    access_token: 'sensitive-access-token',
    refresh_token: 'sensitive-refresh-token',
    expires_at: 1_800_000_000,
    scope: 'openid profile email offline_access',
    token_type: 'Bearer',
    issuer: 'https://auth.openai.com',
    client_id: 'client-id',
    subject: 'subject-1',
    email: 'user@example.com',
    connected_at: CONNECTED_AT,
    status: 'connected',
    ...overrides,
  };
}

function callerFor(user: { id: string } | null) {
  return createCaller({ user } as never);
}

describe('openAiChatGpt.status', () => {
  const getConnection = jest.mocked(getOpenAiChatGptConnection);
  const ensureOrgAccess = jest.mocked(ensureOrganizationAccess);
  const usageLimitRead = jest.mocked(readOpenAiChatGptUsageLimit);

  beforeEach(() => {
    getConnection.mockReset();
    ensureOrgAccess.mockReset();
    usageLimitRead.mockReset();
    usageLimitRead.mockResolvedValue(null);
  });

  it('reports the recorded plan limit for a live connection', async () => {
    getConnection.mockResolvedValue(connectedConnection());
    usageLimitRead.mockResolvedValue({ reachedAt: '2026-09-16T13:00:00.000Z', resetsAt: null });

    await expect(callerFor({ id: USER_ID }).openAiChatGpt.status({})).resolves.toMatchObject({
      state: 'connected',
      usageLimit: { reachedAt: '2026-09-16T13:00:00.000Z', resetsAt: null },
    });
  });

  it('does not read the plan limit for an errored connection', async () => {
    getConnection.mockResolvedValue(
      connectedConnection({ status: 'error', error_message: 'expired' })
    );

    await expect(callerFor({ id: USER_ID }).openAiChatGpt.status({})).resolves.toMatchObject({
      state: 'error',
    });
    expect(usageLimitRead).not.toHaveBeenCalled();
  });

  it('reports disconnected for the signed-in user when no connection is stored', async () => {
    getConnection.mockResolvedValue(null);

    await expect(callerFor({ id: USER_ID }).openAiChatGpt.status({})).resolves.toEqual({
      state: 'disconnected',
    });
    expect(getConnection).toHaveBeenCalledWith(USER_OWNER);
  });

  it('reports connected with the email, the subject and the connected date', async () => {
    getConnection.mockResolvedValue(connectedConnection());

    await expect(callerFor({ id: USER_ID }).openAiChatGpt.status({})).resolves.toEqual({
      state: 'connected',
      email: 'user@example.com',
      subject: 'subject-1',
      connectedAt: CONNECTED_AT,
    });
  });

  it('reports connected without an email when the token has no email claim', async () => {
    getConnection.mockResolvedValue(connectedConnection({ email: undefined }));

    await expect(callerFor({ id: USER_ID }).openAiChatGpt.status({})).resolves.toEqual({
      state: 'connected',
      subject: 'subject-1',
      connectedAt: CONNECTED_AT,
    });
  });

  it('reports the error state with the stored reconnect message', async () => {
    getConnection.mockResolvedValue(
      connectedConnection({ status: 'error', error_message: RECONNECT_MESSAGE })
    );

    await expect(callerFor({ id: USER_ID }).openAiChatGpt.status({})).resolves.toEqual({
      state: 'error',
      email: 'user@example.com',
      subject: 'subject-1',
      connectedAt: CONNECTED_AT,
      errorMessage: RECONNECT_MESSAGE,
    });
  });

  it('never returns the access token, the refresh token or a raw OAuth error body', async () => {
    getConnection.mockResolvedValue(
      connectedConnection({ status: 'error', error_message: RECONNECT_MESSAGE })
    );

    const result = await callerFor({ id: USER_ID }).openAiChatGpt.status({});
    const serialized = JSON.stringify(result);

    expect(Object.keys(result)).not.toContain('access_token');
    expect(Object.keys(result)).not.toContain('refresh_token');
    expect(serialized).not.toContain('sensitive-access-token');
    expect(serialized).not.toContain('sensitive-refresh-token');
  });

  it('scopes the status to the organization after an access check', async () => {
    ensureOrgAccess.mockResolvedValue('owner');
    getConnection.mockResolvedValue(connectedConnection());

    await expect(
      callerFor({ id: USER_ID }).openAiChatGpt.status({ organizationId: ORG_ID })
    ).resolves.toEqual({
      state: 'connected',
      email: 'user@example.com',
      subject: 'subject-1',
      connectedAt: CONNECTED_AT,
    });
    expect(ensureOrgAccess).toHaveBeenCalledWith(expect.anything(), ORG_ID);
    expect(getConnection).toHaveBeenCalledWith(ORG_OWNER);
  });

  it('does not read a connection when the organization access check fails', async () => {
    ensureOrgAccess.mockRejectedValue(new Error('no access'));

    await expect(
      callerFor({ id: USER_ID }).openAiChatGpt.status({ organizationId: ORG_ID })
    ).rejects.toThrow('no access');
    expect(getConnection).not.toHaveBeenCalled();
  });
});

describe('openAiChatGpt.disconnect', () => {
  it('clears the connection in one call and returns the new status', async () => {
    let stored: OpenAiChatGptConnection | null = connectedConnection();
    jest.mocked(getOpenAiChatGptConnection).mockImplementation(async () => stored);
    jest.mocked(clearOpenAiChatGptConnection).mockImplementation(async () => {
      stored = null;
    });

    await expect(callerFor({ id: USER_ID }).openAiChatGpt.disconnect({})).resolves.toEqual({
      state: 'disconnected',
    });
    expect(clearOpenAiChatGptConnection).toHaveBeenCalledWith(USER_OWNER);
  });

  it('clears the organization connection after an access check', async () => {
    jest.mocked(ensureOrganizationAccess).mockResolvedValue('owner');
    jest.mocked(clearOpenAiChatGptConnection).mockResolvedValue(undefined);

    await callerFor({ id: USER_ID }).openAiChatGpt.disconnect({ organizationId: ORG_ID });

    expect(clearOpenAiChatGptConnection).toHaveBeenCalledWith(ORG_OWNER);
  });
});

describe('openAiChatGpt authentication', () => {
  beforeEach(() => {
    jest.mocked(getOpenAiChatGptConnection).mockReset();
    jest.mocked(clearOpenAiChatGptConnection).mockReset();
  });

  it('refuses an unauthenticated caller on status without reading the store', async () => {
    await expect(callerFor(null).openAiChatGpt.status({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(getOpenAiChatGptConnection).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller on disconnect without clearing anything', async () => {
    await expect(callerFor(null).openAiChatGpt.disconnect({})).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    expect(clearOpenAiChatGptConnection).not.toHaveBeenCalled();
  });
});

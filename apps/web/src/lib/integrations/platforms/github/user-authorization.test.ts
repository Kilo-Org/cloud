/* eslint-disable drizzle/enforce-delete-with-where */
import { captureException } from '@sentry/nextjs';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { kilocode_users, user_github_app_tokens } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  disconnectGitHubUserAuthorization,
  exchangeAndStoreGitHubUserAuthorization,
} from './user-authorization';
import { disconnectStoredGitHubUserAuthorization } from './user-authorization-client';

const mockGetAuthenticated = jest.fn();
const mockEncryptKeyedEnvelope = jest.fn(
  (value: string, _scheme: string, _key: unknown, aad: string) => `envelope:${value}:${aad}`
);
const mockDisconnectStoredGitHubUserAuthorization = jest.mocked(
  disconnectStoredGitHubUserAuthorization
);
const mockTokenEncryptionConfig = {
  keyId: 'github-token-key-v1',
  publicKey: Buffer.from('test-public-key').toString('base64'),
};

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: { users: { getAuthenticated: mockGetAuthenticated } },
  })),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/config.server', () => ({
  get USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID() {
    return mockTokenEncryptionConfig.keyId;
  },
  get USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY() {
    return mockTokenEncryptionConfig.publicKey;
  },
}));

jest.mock('@/lib/encryption', () => ({
  encryptKeyedEnvelope: (...args: [string, string, unknown, string]) =>
    mockEncryptKeyedEnvelope(...args),
}));

jest.mock('./app-selector', () => ({
  getGitHubAppCredentials: () => ({
    clientId: 'github-client-id',
    clientSecret: 'github-client-secret',
  }),
}));

jest.mock('./user-authorization-client', () => ({
  disconnectStoredGitHubUserAuthorization: jest.fn(),
}));

function exchangeResponse() {
  return Response.json({
    access_token: 'new-access-token',
    expires_in: 28_800,
    refresh_token: 'new-refresh-token',
    refresh_token_expires_in: 15_552_000,
  });
}

describe('GitHub user authorization', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTokenEncryptionConfig.keyId = 'github-token-key-v1';
    mockTokenEncryptionConfig.publicKey = Buffer.from('test-public-key').toString('base64');
    mockDisconnectStoredGitHubUserAuthorization.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await db.delete(user_github_app_tokens);
    await db.delete(kilocode_users);
  });

  it('stores access and refresh tokens as owner-scoped keyed envelopes', async () => {
    const user = await insertTestUser();
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(exchangeResponse());
    mockGetAuthenticated.mockResolvedValue({ data: { id: 101, login: 'octocat' } });

    await expect(
      exchangeAndStoreGitHubUserAuthorization({
        kiloUserId: user.id,
        code: 'authorization-code',
        codeVerifier: 'code-verifier',
      })
    ).resolves.toEqual({ status: 'connected', githubLogin: 'octocat' });

    const accessAad = `github-user-authorization:v1:${user.id}:standard:101:access`;
    const refreshAad = `github-user-authorization:v1:${user.id}:standard:101:refresh`;
    expect(mockEncryptKeyedEnvelope).toHaveBeenNthCalledWith(
      1,
      'new-access-token',
      'github-user-token-rsa-aes-256-gcm',
      { keyId: 'github-token-key-v1', publicKeyPem: Buffer.from('test-public-key') },
      accessAad
    );
    expect(mockEncryptKeyedEnvelope).toHaveBeenNthCalledWith(
      2,
      'new-refresh-token',
      'github-user-token-rsa-aes-256-gcm',
      { keyId: 'github-token-key-v1', publicKeyPem: Buffer.from('test-public-key') },
      refreshAad
    );
    const [authorization] = await db
      .select()
      .from(user_github_app_tokens)
      .where(eq(user_github_app_tokens.kilo_user_id, user.id));
    expect(authorization?.access_token_encrypted).toBe(`envelope:new-access-token:${accessAad}`);
    expect(authorization?.refresh_token_encrypted).toBe(`envelope:new-refresh-token:${refreshAad}`);
  });

  it('does not store a callback grant when token encryption configuration is missing', async () => {
    const user = await insertTestUser();
    mockTokenEncryptionConfig.publicKey = '';
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(exchangeResponse());
    mockGetAuthenticated.mockResolvedValue({ data: { id: 101, login: 'octocat' } });

    await expect(
      exchangeAndStoreGitHubUserAuthorization({
        kiloUserId: user.id,
        code: 'authorization-code',
        codeVerifier: 'code-verifier',
      })
    ).rejects.toThrow('GitHub user token envelope encryption is not configured');

    await expect(
      db
        .select()
        .from(user_github_app_tokens)
        .where(eq(user_github_app_tokens.kilo_user_id, user.id))
    ).resolves.toHaveLength(0);
    expect(mockEncryptKeyedEnvelope).not.toHaveBeenCalled();
  });

  it('does not persist a callback grant invalidated before serialized storage', async () => {
    const user = await insertTestUser();
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(exchangeResponse());
    mockGetAuthenticated
      .mockResolvedValueOnce({ data: { id: 101, login: 'octocat' } })
      .mockRejectedValueOnce(new Error('GitHub grant revoked'));

    await expect(
      exchangeAndStoreGitHubUserAuthorization({
        kiloUserId: user.id,
        code: 'authorization-code',
        codeVerifier: 'code-verifier',
      })
    ).rejects.toThrow('GitHub grant revoked');

    await expect(
      db
        .select()
        .from(user_github_app_tokens)
        .where(eq(user_github_app_tokens.kilo_user_id, user.id))
    ).resolves.toHaveLength(0);
    expect(mockEncryptKeyedEnvelope).not.toHaveBeenCalled();
  });

  it('delegates persisted authorization disconnect without reading stored tokens', async () => {
    const user = await insertTestUser();
    await db.insert(user_github_app_tokens).values({
      kilo_user_id: user.id,
      github_app_type: 'standard',
      github_user_id: '101',
      github_login: 'octocat',
      access_token_encrypted: 'opaque-access-envelope',
      access_token_expires_at: '2030-01-01T00:00:00.000Z',
      refresh_token_encrypted: 'opaque-refresh-envelope',
      refresh_token_expires_at: '2030-01-01T00:00:00.000Z',
    });
    const fetchMock = jest.spyOn(global, 'fetch');

    await disconnectGitHubUserAuthorization(user.id);

    expect(mockDisconnectStoredGitHubUserAuthorization).toHaveBeenCalledWith(user.id);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(
      db
        .select()
        .from(user_github_app_tokens)
        .where(eq(user_github_app_tokens.kilo_user_id, user.id))
    ).resolves.toHaveLength(1);
  });

  it('captures sanitized delegated disconnect failures', async () => {
    const user = await insertTestUser();
    const serviceError = new Error('GitHub authorization disconnect failed (503)');
    mockDisconnectStoredGitHubUserAuthorization.mockRejectedValueOnce(serviceError);

    await expect(disconnectGitHubUserAuthorization(user.id)).rejects.toThrow(serviceError);

    expect(captureException).toHaveBeenCalledWith(serviceError, {
      tags: { source: 'github_user_authorization_disconnect' },
    });
  });

  it('revokes the transient callback grant when replacing an existing identity', async () => {
    const user = await insertTestUser();
    await db.insert(user_github_app_tokens).values({
      kilo_user_id: user.id,
      github_app_type: 'standard',
      github_user_id: '101',
      github_login: 'octocat',
      access_token_encrypted: 'original-access-envelope',
      access_token_expires_at: '2030-01-01T00:00:00.000Z',
      refresh_token_encrypted: 'original-refresh-envelope',
      refresh_token_expires_at: '2030-01-01T00:00:00.000Z',
    });
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(exchangeResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    mockGetAuthenticated.mockResolvedValue({ data: { id: 202, login: 'hub-b' } });

    await expect(
      exchangeAndStoreGitHubUserAuthorization({
        kiloUserId: user.id,
        code: 'authorization-code',
        codeVerifier: 'code-verifier',
      })
    ).resolves.toEqual({ status: 'disconnect_existing_identity_first' });

    const [authorization] = await db
      .select()
      .from(user_github_app_tokens)
      .where(eq(user_github_app_tokens.kilo_user_id, user.id));
    expect(authorization?.github_user_id).toBe('101');
    expect(authorization?.access_token_encrypted).toBe('original-access-envelope');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://api.github.com/applications/github-client-id/grant'
    );
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        method: 'DELETE',
        body: JSON.stringify({ access_token: 'new-access-token' }),
      })
    );
  });

  it('does not revoke a callback grant already owned by another Kilo account', async () => {
    const owner = await insertTestUser();
    const connectingUser = await insertTestUser();
    await db.insert(user_github_app_tokens).values({
      kilo_user_id: owner.id,
      github_app_type: 'standard',
      github_user_id: '202',
      github_login: 'hub-b',
      access_token_encrypted: 'owner-access-envelope',
      access_token_expires_at: '2030-01-01T00:00:00.000Z',
      refresh_token_encrypted: 'owner-refresh-envelope',
      refresh_token_expires_at: '2030-01-01T00:00:00.000Z',
    });
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValueOnce(exchangeResponse());
    mockGetAuthenticated.mockResolvedValue({ data: { id: 202, login: 'hub-b' } });

    await expect(
      exchangeAndStoreGitHubUserAuthorization({
        kiloUserId: connectingUser.id,
        code: 'authorization-code',
        codeVerifier: 'code-verifier',
      })
    ).resolves.toEqual({ status: 'already_connected_to_another_account' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mockEncryptKeyedEnvelope).not.toHaveBeenCalled();
  });
});

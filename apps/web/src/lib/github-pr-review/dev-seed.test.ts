/**
 * @jest-environment node
 */

const mockEncryptKeyedEnvelope = jest.fn(
  (value: string, _scheme: string, _key: unknown, aad: string) => `envelope:${value}:${aad}`
);

const insertValuesMock = jest.fn().mockReturnThis();
const onConflictMock = jest.fn().mockReturnThis();
const returningMock = jest.fn();
const insertChain = {
  values: insertValuesMock,
  onConflictDoUpdate: onConflictMock,
  returning: returningMock,
};
const insertMock = jest.fn(() => insertChain);
const dbMock = { insert: insertMock };

jest.mock('@/lib/drizzle', () => ({
  get db() {
    return dbMock;
  },
}));

jest.mock('@/lib/config.server', () => ({
  get USER_GITHUB_APP_TOKEN_ACTIVE_KEY_ID() {
    return 'github-token-key-v1';
  },
  get USER_GITHUB_APP_TOKEN_ACTIVE_PUBLIC_KEY() {
    return Buffer.from('test-public-key').toString('base64');
  },
}));

jest.mock('@/lib/encryption', () => ({
  encryptKeyedEnvelope: (...args: [string, string, unknown, string]) =>
    mockEncryptKeyedEnvelope(...args),
}));

import { seedUserGithubToken } from './dev-seed';

beforeEach(() => {
  jest.clearAllMocks();
  insertValuesMock.mockReturnThis();
  onConflictMock.mockReturnThis();
  returningMock.mockResolvedValue([{ id: 'row-1' }]);
});

describe('seedUserGithubToken', () => {
  it('encrypts the token twice with the matching AADs and upserts a standard row', async () => {
    const result = await seedUserGithubToken({
      kiloUserId: 'user-1',
      token: 'fake-token',
      githubLogin: 'octocat',
      githubUserId: '42',
    });

    expect(result).toEqual({ upserted: true, githubLogin: 'octocat' });

    // Two encryption calls — one for access, one for refresh — each with the
    // AAD the real authorization path produces.
    expect(mockEncryptKeyedEnvelope).toHaveBeenCalledTimes(2);
    expect(mockEncryptKeyedEnvelope).toHaveBeenNthCalledWith(
      1,
      'fake-token',
      'github-user-token-rsa-aes-256-gcm',
      expect.objectContaining({ keyId: 'github-token-key-v1' }),
      'github-user-authorization:v1:user-1:standard:42:access'
    );
    expect(mockEncryptKeyedEnvelope).toHaveBeenNthCalledWith(
      2,
      'fake-token',
      'github-user-token-rsa-aes-256-gcm',
      expect.objectContaining({ keyId: 'github-token-key-v1' }),
      'github-user-authorization:v1:user-1:standard:42:refresh'
    );
  });

  it('persists a standard row with far-future expiries and revoked-at null', async () => {
    await seedUserGithubToken({
      kiloUserId: 'user-1',
      token: 'fake-token',
      githubLogin: 'octocat',
      githubUserId: '42',
    });

    const passedValues = insertValuesMock.mock.calls[0]?.[0];
    expect(passedValues).toEqual(
      expect.objectContaining({
        kilo_user_id: 'user-1',
        github_app_type: 'standard',
        github_user_id: '42',
        github_login: 'octocat',
        access_token_expires_at: '9999-12-31T23:59:59.000Z',
        refresh_token_expires_at: '9999-12-31T23:59:59.000Z',
        revoked_at: null,
        revocation_reason: null,
      })
    );
    expect(passedValues.access_token_encrypted).toContain('access');
    expect(passedValues.refresh_token_encrypted).toContain('refresh');
  });

  it('upserts on the (kilo_user_id, github_app_type) unique index', async () => {
    await seedUserGithubToken({
      kiloUserId: 'user-1',
      token: 'fake-token',
      githubLogin: 'octocat',
      githubUserId: '42',
    });

    // The target is a composite (kilo_user_id, github_app_type); we don't
    // reach into the column definitions, just assert the conflict clause was
    // set so the row gets upserted instead of failing on duplicate-key.
    const onConflictArg = onConflictMock.mock.calls[0]?.[0];
    expect(onConflictArg).toBeDefined();
    expect(onConflictArg.set).toBeDefined();
    expect(onConflictArg.setWhere).toBeDefined();
  });

  it('returns upserted=false when no row is returned', async () => {
    returningMock.mockResolvedValueOnce([]);
    const result = await seedUserGithubToken({
      kiloUserId: 'user-1',
      token: 'fake-token',
      githubLogin: 'octocat',
      githubUserId: '42',
    });
    expect(result.upserted).toBe(false);
  });
});

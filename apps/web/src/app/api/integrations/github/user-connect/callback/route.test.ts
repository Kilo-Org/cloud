import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { GET } from './route';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import { user_github_app_tokens } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';

jest.mock('@/lib/integrations/platforms/github/app-selector', () => ({
  getGitHubAppCredentials: jest.fn(() => ({
    clientId: 'client-id',
    clientSecret: 'client-secret',
  })),
}));

jest.mock('@/lib/integrations/platforms/github/oauth-state', () => ({
  verifyOAuthState: jest.fn(),
  safeReturnTo: jest.fn((path: string | undefined) => path ?? '/account/integrations'),
}));

jest.mock('@octokit/oauth-methods', () => ({
  exchangeWebFlowCode: jest.fn(),
}));

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: {
      users: {
        getAuthenticated: jest.fn(async () => ({ data: { id: 123, login: 'alice' } })),
        listEmailsForAuthenticatedUser: jest.fn(async () => ({
          data: [{ email: 'alice@example.com', primary: true }],
        })),
      },
    },
  })),
}));

const { verifyOAuthState } = jest.requireMock('@/lib/integrations/platforms/github/oauth-state');
const { exchangeWebFlowCode } = jest.requireMock('@octokit/oauth-methods');

function makeRequest(url: string) {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

const TEST_USER_ID = 'user-123';

// Key is 32 bytes: base64("12345678901234567890123456789012")
const TEST_ENCRYPTION_KEY = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=';

describe('GitHub user-connect callback', () => {
  beforeEach(async () => {
    process.env.USER_GH_APP_TOKEN_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    await cleanupDbForTest();
    jest.clearAllMocks();
    await insertTestUser({ id: TEST_USER_ID });
  });

  afterEach(() => {
    delete process.env.USER_GH_APP_TOKEN_ENCRYPTION_KEY;
  });

  test('redirects with invalid_state when state verification fails', async () => {
    verifyOAuthState.mockReturnValue(null);
    const request = makeRequest(
      '/api/integrations/github/user-connect/callback?code=abc&state=bad'
    );
    const response = await GET(request);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('gh_error=invalid_state');
  });

  test('redirects with access_denied when GitHub returns error', async () => {
    verifyOAuthState.mockReturnValue({
      kilo_user_id: 'user-123',
      app_type: 'standard',
      return_to: '/account/integrations',
      nonce: 'nonce',
      expires_at: Date.now() / 1000 + 600,
    });
    const request = makeRequest(
      '/api/integrations/github/user-connect/callback?error=access_denied&state=valid'
    );
    const response = await GET(request);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('gh_error=access_denied');
  });

  test('persists encrypted token on happy path', async () => {
    verifyOAuthState.mockReturnValue({
      kilo_user_id: 'user-123',
      app_type: 'standard',
      return_to: '/account/integrations',
      nonce: 'nonce',
      expires_at: Date.now() / 1000 + 600,
    });

    exchangeWebFlowCode.mockResolvedValue({
      authentication: {
        token: 'ghu_abc123',
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      },
    });

    const request = makeRequest(
      '/api/integrations/github/user-connect/callback?code=valid-code&state=valid'
    );
    const response = await GET(request);
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/account/integrations');

    const rows = await db
      .select()
      .from(user_github_app_tokens)
      .where(eq(user_github_app_tokens.kilo_user_id, 'user-123'));
    expect(rows).toHaveLength(1);
    expect(rows[0].github_login).toBe('alice');
    expect(rows[0].github_user_id).toBe('123');
    expect(rows[0].github_email).toBe('alice@example.com');
    expect(rows[0].access_token_encrypted).not.toBe('ghu_abc123');
    expect(rows[0].revoked_at).toBeNull();
  });

  test('onConflictDoUpdate overwrites existing row and resets revoked_at', async () => {
    const { encryptWithSymmetricKey } = await import('@/lib/encryption');
    await db.insert(user_github_app_tokens).values({
      kilo_user_id: 'user-123',
      github_app_type: 'standard',
      github_user_id: '999',
      github_login: 'old-login',
      access_token_encrypted: encryptWithSymmetricKey('old-token', TEST_ENCRYPTION_KEY),
      access_token_expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      revoked_at: new Date().toISOString(),
      revocation_reason: 'user_revoked',
    });

    verifyOAuthState.mockReturnValue({
      kilo_user_id: 'user-123',
      app_type: 'standard',
      return_to: '/account/integrations',
      nonce: 'nonce',
      expires_at: Date.now() / 1000 + 600,
    });

    exchangeWebFlowCode.mockResolvedValue({
      authentication: {
        token: 'ghu_newtoken',
        expiresAt: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
      },
    });

    const request = makeRequest(
      '/api/integrations/github/user-connect/callback?code=valid-code&state=valid'
    );
    await GET(request);

    const rows = await db
      .select()
      .from(user_github_app_tokens)
      .where(eq(user_github_app_tokens.kilo_user_id, 'user-123'));
    expect(rows).toHaveLength(1);
    expect(rows[0].github_login).toBe('alice');
    expect(rows[0].revoked_at).toBeNull();
    expect(rows[0].revocation_reason).toBeNull();
  });
});

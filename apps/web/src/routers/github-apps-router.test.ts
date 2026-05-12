import { beforeEach, describe, expect, test } from '@jest/globals';
import { db, cleanupDbForTest } from '@/lib/drizzle';
import { githubAppsRouter } from './github-apps-router';
import { user_github_app_tokens, kilocode_users } from '@kilocode/db/schema';
import { encryptWithSymmetricKey } from '@/lib/encryption';
import { eq } from 'drizzle-orm';
import { defineTestUser } from '@/tests/helpers/user.helper';

// Mock the env vars
jest.mock('@/lib/config.server', () => ({
  USER_GH_APP_TOKEN_ENCRYPTION_KEY: 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXk=',
  ENABLE_GITHUB_USER_TOKENS: true,
  GITHUB_OAUTH_STATE_SECRET: 'test-secret-test-secret-test-secret-test-secret=',
}));

jest.mock('@/lib/integrations/platforms/github/app-selector', () => ({
  getGitHubAppCredentials: jest.fn(() => ({
    appId: 'app-id',
    privateKey: 'private-key',
    clientId: 'client-id',
    clientSecret: 'client-secret',
    appName: 'KiloConnect',
    webhookSecret: 'webhook-secret',
  })),
  getGitHubAppTypeForOrganization: jest.fn(async () => 'standard'),
}));

const TEST_USER_ID = 'user-123';

describe('githubAppsRouter', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    await db
      .insert(kilocode_users)
      .values(defineTestUser({ id: TEST_USER_ID }))
      .onConflictDoNothing();
  });

  const getCaller = () =>
    githubAppsRouter.createCaller({ user: defineTestUser({ id: TEST_USER_ID }) });

  describe('connectUserIdentity', () => {
    test('rejects lite app', async () => {
      const caller = getCaller();
      await expect(caller.connectUserIdentity({ appType: 'lite' })).rejects.toThrow(
        'Lite app does not support user identity connect'
      );
    });

    test('builds correct authorize URL', async () => {
      const caller = getCaller();
      const result = await caller.connectUserIdentity({ appType: 'standard' });
      expect(result.authorizeUrl).toContain('https://github.com/login/oauth/authorize');
      expect(result.authorizeUrl).toContain('client_id=client-id');
      expect(result.authorizeUrl).toContain('state=');
    });
  });

  describe('getUserConnectionStatus', () => {
    test('returns connected false when no row', async () => {
      const caller = getCaller();
      const result = await caller.getUserConnectionStatus();
      expect(result.connected).toBe(false);
      expect(result.login).toBeUndefined();
    });

    test('returns connected true with valid row', async () => {
      const encryptionKey = 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXk=';
      await db.insert(user_github_app_tokens).values({
        kilo_user_id: TEST_USER_ID,
        github_app_type: 'standard',
        github_user_id: '456',
        github_login: 'alice',
        github_email: 'alice@example.com',
        access_token_encrypted: encryptWithSymmetricKey('ghu_token', encryptionKey),
        access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      const caller = getCaller();
      const result = await caller.getUserConnectionStatus();
      expect(result.connected).toBe(true);
      expect(result.login).toBe('alice');
      expect(result.githubUserId).toBe('456');
    });

    test('returns connected false when token expired', async () => {
      const encryptionKey = 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXk=';
      await db.insert(user_github_app_tokens).values({
        kilo_user_id: TEST_USER_ID,
        github_app_type: 'standard',
        github_user_id: '456',
        github_login: 'alice',
        access_token_encrypted: encryptWithSymmetricKey('ghu_token', encryptionKey),
        access_token_expires_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      });

      const caller = getCaller();
      const result = await caller.getUserConnectionStatus();
      expect(result.connected).toBe(false);
      expect(result.login).toBe('alice');
    });
  });

  describe('disconnectUserIdentity', () => {
    test('deletes row and returns ok', async () => {
      const encryptionKey = 'dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXk=';
      await db.insert(user_github_app_tokens).values({
        kilo_user_id: TEST_USER_ID,
        github_app_type: 'standard',
        github_user_id: '456',
        github_login: 'alice',
        access_token_encrypted: encryptWithSymmetricKey('ghu_token', encryptionKey),
        access_token_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });

      const caller = getCaller();
      const result = await caller.disconnectUserIdentity();
      expect(result.ok).toBe(true);

      const rows = await db
        .select()
        .from(user_github_app_tokens)
        .where(eq(user_github_app_tokens.kilo_user_id, TEST_USER_ID));
      expect(rows).toHaveLength(0);
    });
  });
});

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { db } from '@/lib/drizzle';
import type { User } from '@kilocode/db/schema';
import { user_auth_provider, kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  getUserAuthProviders,
  linkAuthProviderToUser,
  unlinkAuthProviderFromUser,
  findUserIdByAuthProvider,
} from '@/lib/user';
import { insertTestUserAndGoogleAuth } from '@/tests/helpers/user.helper';
import { assertNotNullish } from '@/lib/utils';

describe('Multi-Auth System', () => {
  let testUserId: string;
  let testUser: User;
  let testUserGoogleProviderId: string;

  beforeEach(async () => {
    // Create a test user with initial Google auth
    testUser = await insertTestUserAndGoogleAuth();
    testUserId = testUser.id;

    // Get the provider_account_id for the Google auth provider that was created
    const providers = await getUserAuthProviders(testUserId);
    const googleProvider = providers.find(p => p.provider === 'google');
    assertNotNullish(googleProvider);
    testUserGoogleProviderId = googleProvider.provider_account_id;
  });

  afterEach(async () => {
    // Clean up test data
    await db.delete(user_auth_provider).where(eq(user_auth_provider.kilo_user_id, testUserId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUserId));
  });

  describe('getUserAuthProviders', () => {
    test('should return all auth providers for a user', async () => {
      const providers = await getUserAuthProviders(testUserId);
      expect(providers).toHaveLength(1);
      expect(providers[0].provider).toBe('google');
    });

    test('should return empty array for non-existent user', async () => {
      const providers = await getUserAuthProviders('non-existent-user');
      expect(providers).toHaveLength(0);
    });
  });

  describe('linkAuthProviderToUser', () => {
    test('should successfully link a new auth provider', async () => {
      const result = await linkAuthProviderToUser({
        kilo_user_id: testUserId,
        provider: 'github',
        provider_account_id: 'github-123',
        email: 'test@example.com',
        avatar_url: 'https://example.com/avatar.jpg',
        hosted_domain: null,
      });

      expect(result.success).toBe(true);

      // Verify it was actually saved
      const providers = await getUserAuthProviders(testUserId);
      expect(providers).toHaveLength(2);

      const githubProviderFromDb = providers.find(p => p.provider === 'github');
      expect(githubProviderFromDb).toBeDefined();
      expect(githubProviderFromDb!.kilo_user_id).toBe(testUserId);
      expect(githubProviderFromDb!.provider_account_id).toBe('github-123');
    });

    test('should prevent linking same provider twice', async () => {
      const result = await linkAuthProviderToUser({
        kilo_user_id: testUserId,
        provider: 'google',
        provider_account_id: 'google-456',
        email: 'test2@example.com',
        avatar_url: 'https://example.com/avatar2.jpg',
        hosted_domain: null,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('PROVIDER-ALREADY-LINKED');
      }
    });

    test('should prevent linking account already linked to another user', async () => {
      // Create another test user
      const otherUser = await insertTestUserAndGoogleAuth();

      try {
        // Try to link the same Google account to different user
        const result = await linkAuthProviderToUser({
          kilo_user_id: otherUser.id,
          provider: 'google',
          provider_account_id: testUserGoogleProviderId, // Same as original user
          email: 'test3@example.com',
          avatar_url: 'https://example.com/avatar3.jpg',
          hosted_domain: null,
        });

        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error).toBe('ACCOUNT-ALREADY-LINKED');
        }
      } finally {
        // Clean up
        await db
          .delete(user_auth_provider)
          .where(eq(user_auth_provider.kilo_user_id, otherUser.id));
        await db.delete(kilocode_users).where(eq(kilocode_users.id, otherUser.id));
      }
    });
  });

  describe('unlinkAuthProviderFromUser', () => {
    beforeEach(async () => {
      // Add a second provider so we can test unlinking
      await linkAuthProviderToUser({
        kilo_user_id: testUserId,
        provider: 'github',
        provider_account_id: 'github-123',
        email: 'test@example.com',
        avatar_url: 'https://example.com/avatar.jpg',
        hosted_domain: null,
      });
    });

    test('should successfully unlink auth provider', async () => {
      await unlinkAuthProviderFromUser(testUserId, 'github');

      const providers = await getUserAuthProviders(testUserId);
      expect(providers).toHaveLength(1);
      expect(providers[0].provider).toBe('google');
    });

    test('should prevent unlinking the last auth provider', async () => {
      // First unlink github
      await unlinkAuthProviderFromUser(testUserId, 'github');

      const res = await unlinkAuthProviderFromUser(testUserId, 'google');
      // Try to unlink the last remaining provider (google)
      expect(res.success ? null : res.error.message).toBe(
        'Cannot unlink the last authentication method'
      );
    });

    test('should handle unlinking non-existent provider', async () => {
      const res = await unlinkAuthProviderFromUser(testUserId, 'fake-login');
      expect(res.success).toBe(false);
      expect(!res.success ? res.error.message : null).toBe(
        'User does not have a linked fake-login account'
      );
    });
  });

  describe('findUserByProviderAccount', () => {
    test('should find user by provider account', async () => {
      const result = await findUserIdByAuthProvider('google', testUserGoogleProviderId);
      expect(result).toBe(testUserId);
    });

    test('should return null for non-existent provider account', async () => {
      const result = await findUserIdByAuthProvider('github', 'non-existent-id');
      expect(result).toBeNull();
    });
  });
});

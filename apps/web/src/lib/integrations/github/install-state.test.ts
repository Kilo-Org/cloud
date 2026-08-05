import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { github_install_states, kilocode_users } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import {
  createInstallState,
  consumeInstallState,
  cleanupExpiredInstallStates,
} from './install-state';

describe('install-state', () => {
  const testUserId = 'test-install-user-' + Date.now();
  const testUserEmail = `test-install-${Date.now()}@example.com`;

  beforeEach(async () => {
    await db.insert(kilocode_users).values({
      id: testUserId,
      google_user_email: testUserEmail,
      google_user_name: 'Test Install User',
      google_user_image_url: 'https://example.com/avatar.jpg',
      stripe_customer_id: 'cus_test_install',
    });
  });

  afterEach(async () => {
    await db
      .delete(github_install_states)
      .where(eq(github_install_states.kilo_user_id, testUserId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, testUserId));
  });

  describe('createInstallState', () => {
    test('creates a row and returns a base64url token', async () => {
      const token = await createInstallState({
        kiloUserId: testUserId,
        ownerType: 'org',
        ownerId: 'org-1',
        githubAppType: 'standard',
        returnTo: '/github-app',
      });

      expect(token).toBeTruthy();
      expect(typeof token).toBe('string');
      // 32 random bytes base64url-encoded = 43 characters (no padding)
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    test('stores the row in the database', async () => {
      const token = await createInstallState({
        kiloUserId: testUserId,
        ownerType: 'user',
        ownerId: testUserId,
        githubAppType: 'lite',
        returnTo: null,
      });

      const rows = await db
        .select()
        .from(github_install_states)
        .where(eq(github_install_states.token, token));

      expect(rows).toHaveLength(1);
      expect(rows[0].kilo_user_id).toBe(testUserId);
      expect(rows[0].owner_type).toBe('user');
      expect(rows[0].owner_id).toBe(testUserId);
      expect(rows[0].github_app_type).toBe('lite');
      expect(rows[0].return_to).toBeNull();
      expect(rows[0].consumed_at).toBeNull();
      expect(rows[0].expires_at).toBeTruthy();
    });
  });

  describe('consumeInstallState', () => {
    test('consumes a fresh token exactly once', async () => {
      const token = await createInstallState({
        kiloUserId: testUserId,
        ownerType: 'org',
        ownerId: 'org-2',
        githubAppType: 'standard',
      });

      const first = await consumeInstallState(token);
      expect(first).not.toBeNull();
      expect(first!.token).toBe(token);
      expect(first!.consumed_at).toBeTruthy();

      const second = await consumeInstallState(token);
      expect(second).toBeNull();
    });

    test('returns null for an unknown token', async () => {
      const result = await consumeInstallState('nonexistent-token');
      expect(result).toBeNull();
    });

    test('returns null for an expired token', async () => {
      // Insert a token with an already-past expires_at
      const expiredToken = 'expired-test-token-' + Date.now();
      await db.insert(github_install_states).values({
        token: expiredToken,
        kilo_user_id: testUserId,
        owner_type: 'user',
        owner_id: testUserId,
        github_app_type: 'standard',
        expires_at: new Date(Date.now() - 1000).toISOString(),
      });

      const result = await consumeInstallState(expiredToken);
      expect(result).toBeNull();
    });

    test('returns null for a consumed token', async () => {
      const token = await createInstallState({
        kiloUserId: testUserId,
        ownerType: 'org',
        ownerId: 'org-3',
        githubAppType: 'standard',
      });

      // Pre-consume by setting consumed_at directly
      await db
        .update(github_install_states)
        .set({ consumed_at: sql`NOW()` })
        .where(eq(github_install_states.token, token));

      const result = await consumeInstallState(token);
      expect(result).toBeNull();
    });

    test('returns the full row with all fields', async () => {
      const token = await createInstallState({
        kiloUserId: testUserId,
        ownerType: 'org',
        ownerId: 'org-4',
        githubAppType: 'lite',
        returnTo: '/some/path',
      });

      const row = await consumeInstallState(token);
      expect(row).not.toBeNull();
      expect(row!.kilo_user_id).toBe(testUserId);
      expect(row!.owner_type).toBe('org');
      expect(row!.owner_id).toBe('org-4');
      expect(row!.github_app_type).toBe('lite');
      expect(row!.return_to).toBe('/some/path');
    });
  });

  describe('cleanupExpiredInstallStates', () => {
    test('deletes expired rows', async () => {
      // Insert an already-expired row
      await db.insert(github_install_states).values({
        token: 'cleanup-expired-' + Date.now(),
        kilo_user_id: testUserId,
        owner_type: 'user',
        owner_id: testUserId,
        github_app_type: 'standard',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      });

      const deleted = await cleanupExpiredInstallStates();
      expect(deleted).toBeGreaterThanOrEqual(1);

      // Verify the expired row is gone
      const remaining = await db
        .select()
        .from(github_install_states)
        .where(eq(github_install_states.kilo_user_id, testUserId));

      expect(remaining.filter(r => r.expires_at <= new Date().toISOString())).toHaveLength(0);
    });

    test('does not delete non-expired rows', async () => {
      const token = await createInstallState({
        kiloUserId: testUserId,
        ownerType: 'org',
        ownerId: 'org-5',
        githubAppType: 'standard',
      });

      await cleanupExpiredInstallStates();

      const rows = await db
        .select()
        .from(github_install_states)
        .where(eq(github_install_states.token, token));

      expect(rows).toHaveLength(1);
    });
  });
});

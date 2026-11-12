import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import type { User } from '@kilocode/db/schema';
import { rootRouter } from './root-router';

// Test users will be created dynamically
let regularUser: User;
let adminUser: User;
let creditManagerUser: User;

describe('trpc tests', () => {
  beforeAll(async () => {
    // Create test users using the helper function
    regularUser = await insertTestUser({
      google_user_email: 'regular@example.com',
      google_user_name: 'Regular User',
      is_admin: false,
    });

    adminUser = await insertTestUser({
      google_user_email: 'admin@admin.example.com',
      google_user_name: 'Admin User',
      is_admin: true,
    });

    creditManagerUser = await insertTestUser({
      google_user_email: 'credit-manager@admin.example.com',
      google_user_name: 'Credit Manager User',
      is_admin: true,
      can_manage_credits: true,
    });
  });

  afterAll(async () => {
    // Test cleanup is handled automatically by the test framework
  });

  describe('router composition', () => {
    it('registers providerReview on the server root so mobile calls resolve', () => {
      expect(rootRouter._def.record).toHaveProperty('providerReview');
      expect(rootRouter._def.record).toHaveProperty('providerReview.getPullRequest');
      expect(rootRouter._def.record).toHaveProperty('providerReview.addComment');
    });

    it('registers Bitbucket only under organizations', () => {
      expect(rootRouter._def.record).not.toHaveProperty('bitbucket');
      expect(rootRouter._def.record).toHaveProperty('organizations.bitbucket');
      expect(rootRouter._def.record).not.toHaveProperty('cloudAgentNext.listBitbucketRepositories');
      expect(rootRouter._def.record).toHaveProperty(
        'organizations.cloudAgentNext.listBitbucketRepositories'
      );
    });
  });

  describe('admin permissions', () => {
    it('returns the authenticated admin credit capability', async () => {
      const adminCaller = await createCallerForUser(adminUser.id);
      const creditManagerCaller = await createCallerForUser(creditManagerUser.id);

      await expect(adminCaller.admin.getPermissions()).resolves.toEqual({
        isSuperadmin: false,
        canViewSessions: false,
        canManageCredits: false,
        canExportApiRequestLogs: false,
      });
      await expect(creditManagerCaller.admin.getPermissions()).resolves.toEqual({
        isSuperadmin: false,
        canViewSessions: false,
        canManageCredits: true,
        canExportApiRequestLogs: false,
      });
    });
  });

  describe('adminHello procedure', () => {
    it('should throw FORBIDDEN error for non-admin users', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(caller.test.adminHello()).rejects.toThrow('Admin access required');
    });
  });
});

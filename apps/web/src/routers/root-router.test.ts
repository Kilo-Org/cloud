import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { kilocode_users, type User } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { eq } from 'drizzle-orm';

// Test users will be created dynamically
let regularUser: User;
let adminUser: User;

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
  });

  afterAll(async () => {
    // Test cleanup is handled automatically by the test framework
  });

  describe('hello procedure', () => {
    it('should greet the user with custom text', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.test.hello({ text: 'test' });

      expect(result).toEqual({
        greeting: `hello test from user ${regularUser.id}`,
      });
    });

    it('should greet the user with default text when no input provided', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.test.hello();

      expect(result).toEqual({
        greeting: `hello world from user ${regularUser.id}`,
      });
    });

    it('should greet the user with undefined input', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.test.hello(undefined);

      expect(result).toEqual({
        greeting: `hello world from user ${regularUser.id}`,
      });
    });
  });

  describe('admin permissions', () => {
    it('reflects database capability changes without recreating the caller', async () => {
      const caller = await createCallerForUser(adminUser.id);

      await expect(caller.admin.getPermissions()).resolves.toEqual({ canManageCredits: false });

      await db
        .update(kilocode_users)
        .set({ can_manage_credits: true })
        .where(eq(kilocode_users.id, adminUser.id));

      await expect(caller.admin.getPermissions()).resolves.toEqual({ canManageCredits: true });
    });
  });

  describe('adminHello procedure', () => {
    it('should return hello world for admin users', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.test.adminHello();

      expect(result).toEqual({
        message: 'hello world',
      });
    });

    it('should throw FORBIDDEN error for non-admin users', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(caller.test.adminHello()).rejects.toThrow('Admin access required');
    });
  });
});

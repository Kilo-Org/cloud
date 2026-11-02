import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  canCurrentUserViewSessions,
  userCanViewSessions,
  userIsSuperadmin,
} from '@/lib/admin/admin-permissions';
import { defineTestUser, insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { kilocode_users } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';

describe('admin permissions', () => {
  it.each([
    [{ is_admin: false, is_super_admin: false }, false],
    [{ is_admin: false, is_super_admin: true }, false],
    [{ is_admin: true, is_super_admin: false }, false],
    [{ is_admin: true, is_super_admin: true }, true],
  ] as const)('evaluates superadmin state %#', (permissions, expected) => {
    expect(userIsSuperadmin(defineTestUser(permissions))).toBe(expected);
  });

  it.each([
    [{ is_admin: false, can_view_sessions: false }, false],
    [{ is_admin: false, can_view_sessions: true }, false],
    [{ is_admin: true, can_view_sessions: false }, false],
    [{ is_admin: true, can_view_sessions: true }, true],
  ] as const)('evaluates session-viewer state %#', (permissions, expected) => {
    expect(userCanViewSessions(defineTestUser(permissions))).toBe(expected);
  });

  it('enforces every subordinate permission database invariant', async () => {
    await expect(insertTestUser({ is_admin: false, is_super_admin: true })).rejects.toThrow();
    await expect(insertTestUser({ is_admin: false, can_view_sessions: true })).rejects.toThrow();

    const admin = await insertTestUser({
      is_admin: true,
      is_super_admin: true,
      can_view_sessions: true,
      can_manage_credits: true,
    });

    await expect(
      db.update(kilocode_users).set({ is_admin: false }).where(eq(kilocode_users.id, admin.id))
    ).rejects.toThrow();

    await expect(
      db
        .update(kilocode_users)
        .set({
          is_admin: false,
          is_super_admin: false,
          can_view_sessions: false,
          can_manage_credits: false,
        })
        .where(eq(kilocode_users.id, admin.id))
    ).resolves.toBeDefined();
  });

  describe('canCurrentUserViewSessions', () => {
    const createdUserIds: string[] = [];

    async function createUser(overrides: Parameters<typeof insertTestUser>[0]) {
      const user = await insertTestUser(overrides);
      createdUserIds.push(user.id);
      return user;
    }

    afterEach(async () => {
      await db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
      createdUserIds.length = 0;
    });

    it('follows the stored permission of the caller', async () => {
      const viewer = await createUser({ is_admin: true, can_view_sessions: true });
      const admin = await createUser({ is_admin: true });

      expect(await canCurrentUserViewSessions(viewer.id)).toBe(true);
      expect(await canCurrentUserViewSessions(admin.id)).toBe(false);
    });

    it('follows a permission change without a new sign-in', async () => {
      const admin = await createUser({ is_admin: true });

      expect(await canCurrentUserViewSessions(admin.id)).toBe(false);

      await db
        .update(kilocode_users)
        .set({ can_view_sessions: true })
        .where(eq(kilocode_users.id, admin.id));

      expect(await canCurrentUserViewSessions(admin.id)).toBe(true);
    });

    it('rejects a blocked admin and an unknown user', async () => {
      const blocked = await createUser({
        is_admin: true,
        can_view_sessions: true,
        blocked_reason: 'manual block',
      });

      expect(await canCurrentUserViewSessions(blocked.id)).toBe(false);
      expect(await canCurrentUserViewSessions('missing-admin-user')).toBe(false);
    });
  });
});

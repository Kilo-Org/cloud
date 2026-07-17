import { db } from '@/lib/drizzle';
import { userCanViewSessions, userIsSuperadmin } from '@/lib/admin/admin-permissions';
import { defineTestUser, insertTestUser } from '@/tests/helpers/user.helper';
import { kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

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
});

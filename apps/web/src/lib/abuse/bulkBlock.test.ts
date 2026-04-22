import { describe, test, expect } from '@jest/globals';
import { bulkBlockUsers, unblockBulkBlockedUsers } from '@/lib/abuse/bulkBlock';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';

describe('bulkBlockUsers (integration)', () => {
  test('blocks 2 via id and 2 via email only when there is no nonsense; with nonsense none are blocked', async () => {
    // Arrange: create 4 users
    const admin = await insertTestUser({ is_admin: true });
    const uById1 = await insertTestUser();
    const uById2 = await insertTestUser();

    const unique1 = `bulkblock-${Date.now()}-${Math.random()}`;
    const unique2 = `bulkblock-${Date.now()}-${Math.random()}`;
    const uByEmail1 = await insertTestUser({ google_user_email: `${unique1}@example.com` });
    const uByEmail2 = await insertTestUser({ google_user_email: `${unique2}@example.com` });

    const ids = [uById1.id, uById2.id];
    const emails = [uByEmail1.google_user_email, uByEmail2.google_user_email];

    const nonsense = 'non-existent-user@example.com';

    // Case A: include nonsense identifier - expect failure and no users blocked
    const reasonA = 'test-reason-A';
    const resA = await bulkBlockUsers([...ids, ...emails, nonsense], reasonA, admin.id);
    expect(resA.success).toBe(false);
    if (!resA.success) {
      // Should surface at least one error about users not found
      expect(resA.error).toMatch(/not found/);
      // Should suggest valid ids to keep
      expect(resA.foundIds.sort()).toEqual(
        [uById1.id, uById2.id, uByEmail1.id, uByEmail2.id].sort()
      );
    }

    // Verify none of the four users were blocked
    const rowsA = await db
      .select({
        id: kilocode_users.id,
        blocked_reason: kilocode_users.blocked_reason,
        blocked_at: kilocode_users.blocked_at,
        blocked_by_kilo_user_id: kilocode_users.blocked_by_kilo_user_id,
      })
      .from(kilocode_users)
      .where(inArray(kilocode_users.id, [uById1.id, uById2.id, uByEmail1.id, uByEmail2.id]));

    for (const r of rowsA) {
      expect(r.blocked_reason).toBeNull();
      expect(r.blocked_at).toBeNull();
      expect(r.blocked_by_kilo_user_id).toBeNull();
    }

    // Case B: exclude nonsense - expect success and exactly 4 users blocked
    const reasonB = 'test-reason-B';
    const beforeBlock = Date.now();
    const resB = await bulkBlockUsers([...ids, ...emails], reasonB, admin.id);
    expect(resB.success).toBe(true);
    if (resB.success) {
      expect(resB.updatedCount).toBe(4);
    }

    // Verify all four users are now blocked with reasonB
    const rowsB = await db
      .select({
        id: kilocode_users.id,
        blocked_reason: kilocode_users.blocked_reason,
        blocked_at: kilocode_users.blocked_at,
        blocked_by_kilo_user_id: kilocode_users.blocked_by_kilo_user_id,
      })
      .from(kilocode_users)
      .where(inArray(kilocode_users.id, [uById1.id, uById2.id, uByEmail1.id, uByEmail2.id]));

    for (const row of rowsB) {
      expect(row.blocked_reason).toBe(reasonB);
      expect(row.blocked_by_kilo_user_id).toBe(admin.id);
      expect(row.blocked_at).not.toBeNull();
      if (row.blocked_at) {
        expect(new Date(row.blocked_at).getTime()).toBeGreaterThanOrEqual(beforeBlock);
      }
    }
  });

  test('unblocks a grouped bulk block by reason, date, and admin only', async () => {
    const targetDate = '2026-01-15';
    const reason = `test-unblock-${Date.now()}-${Math.random()}`;
    const otherReason = `${reason}-other`;

    const admin = await insertTestUser({ is_admin: true });
    const otherAdmin = await insertTestUser({ is_admin: true });
    const targetUser1 = await insertTestUser();
    const targetUser2 = await insertTestUser();
    const otherReasonUser = await insertTestUser();
    const otherDateUser = await insertTestUser();
    const otherAdminUser = await insertTestUser();

    await db
      .update(kilocode_users)
      .set({
        blocked_reason: reason,
        blocked_at: `${targetDate}T12:00:00.000Z`,
        blocked_by_kilo_user_id: admin.id,
      })
      .where(inArray(kilocode_users.id, [targetUser1.id, targetUser2.id]));

    await db
      .update(kilocode_users)
      .set({
        blocked_reason: otherReason,
        blocked_at: `${targetDate}T12:00:00.000Z`,
        blocked_by_kilo_user_id: admin.id,
      })
      .where(inArray(kilocode_users.id, [otherReasonUser.id]));

    await db
      .update(kilocode_users)
      .set({
        blocked_reason: reason,
        blocked_at: '2026-01-16T12:00:00.000Z',
        blocked_by_kilo_user_id: admin.id,
      })
      .where(inArray(kilocode_users.id, [otherDateUser.id]));

    await db
      .update(kilocode_users)
      .set({
        blocked_reason: reason,
        blocked_at: `${targetDate}T12:00:00.000Z`,
        blocked_by_kilo_user_id: otherAdmin.id,
      })
      .where(inArray(kilocode_users.id, [otherAdminUser.id]));

    const result = await unblockBulkBlockedUsers(reason, targetDate, admin.id);

    expect(result.updatedCount).toBe(2);

    const rows = await db
      .select({
        id: kilocode_users.id,
        blocked_reason: kilocode_users.blocked_reason,
        blocked_at: kilocode_users.blocked_at,
        blocked_by_kilo_user_id: kilocode_users.blocked_by_kilo_user_id,
      })
      .from(kilocode_users)
      .where(
        inArray(kilocode_users.id, [
          targetUser1.id,
          targetUser2.id,
          otherReasonUser.id,
          otherDateUser.id,
          otherAdminUser.id,
        ])
      );

    const usersById = new Map(rows.map(r => [r.id, r]));
    expect(usersById.get(targetUser1.id)?.blocked_reason).toBeNull();
    expect(usersById.get(targetUser1.id)?.blocked_at).toBeNull();
    expect(usersById.get(targetUser1.id)?.blocked_by_kilo_user_id).toBeNull();
    expect(usersById.get(targetUser2.id)?.blocked_reason).toBeNull();
    expect(usersById.get(targetUser2.id)?.blocked_at).toBeNull();
    expect(usersById.get(targetUser2.id)?.blocked_by_kilo_user_id).toBeNull();
    expect(usersById.get(otherReasonUser.id)?.blocked_reason).toBe(otherReason);
    expect(usersById.get(otherDateUser.id)?.blocked_reason).toBe(reason);
    expect(usersById.get(otherAdminUser.id)?.blocked_reason).toBe(reason);
    expect(usersById.get(otherAdminUser.id)?.blocked_by_kilo_user_id).toBe(otherAdmin.id);
  });
});

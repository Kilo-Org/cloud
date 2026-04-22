import { describe, test, expect } from '@jest/globals';
import { bulkBlockUsers, unblockBulkBlockedUsers } from '@/lib/abuse/bulkBlock';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { inArray } from 'drizzle-orm';

describe('bulkBlockUsers (integration)', () => {
  test('blocks 2 via id and 2 via email only when there is no nonsense; with nonsense none are blocked', async () => {
    // Arrange: create 4 users
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
    const resA = await bulkBlockUsers([...ids, ...emails, nonsense], reasonA);
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
      .select({ id: kilocode_users.id, blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(inArray(kilocode_users.id, [uById1.id, uById2.id, uByEmail1.id, uByEmail2.id]));

    for (const r of rowsA) {
      expect(r.blocked_reason).toBeNull();
    }

    // Case B: exclude nonsense - expect success and exactly 4 users blocked
    const reasonB = 'test-reason-B';
    const resB = await bulkBlockUsers([...ids, ...emails], reasonB);
    expect(resB.success).toBe(true);
    if (resB.success) {
      expect(resB.updatedCount).toBe(4);
    }

    // Verify all four users are now blocked with reasonB
    const rowsB = await db
      .select({ id: kilocode_users.id, blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(inArray(kilocode_users.id, [uById1.id, uById2.id, uByEmail1.id, uByEmail2.id]));

    const reasons = new Map(rowsB.map(r => [r.id, r.blocked_reason]));
    expect(reasons.get(uById1.id)).toBe(reasonB);
    expect(reasons.get(uById2.id)).toBe(reasonB);
    expect(reasons.get(uByEmail1.id)).toBe(reasonB);
    expect(reasons.get(uByEmail2.id)).toBe(reasonB);
  });

  test('unblocks a grouped bulk block by reason and date only', async () => {
    const targetDate = '2026-01-15';
    const reason = `test-unblock-${Date.now()}-${Math.random()}`;
    const otherReason = `${reason}-other`;

    const targetUser1 = await insertTestUser();
    const targetUser2 = await insertTestUser();
    const otherReasonUser = await insertTestUser();
    const otherDateUser = await insertTestUser();

    await db
      .update(kilocode_users)
      .set({ blocked_reason: reason, updated_at: `${targetDate}T12:00:00.000Z` })
      .where(inArray(kilocode_users.id, [targetUser1.id, targetUser2.id]));

    await db
      .update(kilocode_users)
      .set({ blocked_reason: otherReason, updated_at: `${targetDate}T12:00:00.000Z` })
      .where(inArray(kilocode_users.id, [otherReasonUser.id]));

    await db
      .update(kilocode_users)
      .set({ blocked_reason: reason, updated_at: '2026-01-16T12:00:00.000Z' })
      .where(inArray(kilocode_users.id, [otherDateUser.id]));

    const result = await unblockBulkBlockedUsers(reason, targetDate);

    expect(result.updatedCount).toBe(2);

    const rows = await db
      .select({ id: kilocode_users.id, blocked_reason: kilocode_users.blocked_reason })
      .from(kilocode_users)
      .where(
        inArray(kilocode_users.id, [
          targetUser1.id,
          targetUser2.id,
          otherReasonUser.id,
          otherDateUser.id,
        ])
      );

    const reasons = new Map(rows.map(r => [r.id, r.blocked_reason]));
    expect(reasons.get(targetUser1.id)).toBeNull();
    expect(reasons.get(targetUser2.id)).toBeNull();
    expect(reasons.get(otherReasonUser.id)).toBe(otherReason);
    expect(reasons.get(otherDateUser.id)).toBe(reason);
  });
});

import { db } from '@/lib/drizzle';
import { userCanManageCredits } from '@/lib/admin/credit-management';
import { defineTestUser, insertTestUser } from '@/tests/helpers/user.helper';
import { credit_transactions, kilocode_users } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';

describe('credit management authorization', () => {
  it.each([
    [{ is_admin: false, can_manage_credits: false }, false],
    [{ is_admin: false, can_manage_credits: true }, false],
    [{ is_admin: true, can_manage_credits: false }, false],
    [{ is_admin: true, can_manage_credits: true }, true],
  ] as const)('evaluates permission state %#', (permissions, expected) => {
    expect(userCanManageCredits(defineTestUser(permissions))).toBe(expected);
  });

  it('enforces the admin capability database invariant', async () => {
    await expect(insertTestUser({ is_admin: false, can_manage_credits: true })).rejects.toThrow();

    const manager = await insertTestUser({ is_admin: true, can_manage_credits: true });
    await expect(
      db.update(kilocode_users).set({ is_admin: false }).where(eq(kilocode_users.id, manager.id))
    ).rejects.toThrow();

    await expect(
      db
        .update(kilocode_users)
        .set({ is_admin: false, can_manage_credits: false })
        .where(eq(kilocode_users.id, manager.id))
    ).resolves.toBeDefined();
  });

  it('rejects nonexistent transaction creator IDs', async () => {
    await expect(
      db.insert(credit_transactions).values({
        kilo_user_id: crypto.randomUUID(),
        created_by_kilo_user_id: crypto.randomUUID(),
        amount_microdollars: 1,
        is_free: true,
      })
    ).rejects.toThrow();
  });

  it('prevents hard deletion of an attributed creator', async () => {
    const creator = await insertTestUser({ is_admin: true });
    const recipient = await insertTestUser();
    const [transaction] = await db
      .insert(credit_transactions)
      .values({
        kilo_user_id: recipient.id,
        created_by_kilo_user_id: creator.id,
        amount_microdollars: 1,
        is_free: true,
      })
      .returning({ id: credit_transactions.id });
    if (!transaction) throw new Error('Failed to create attributed transaction');

    await expect(
      db.delete(kilocode_users).where(eq(kilocode_users.id, creator.id))
    ).rejects.toThrow();

    const [preservedCreator] = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, creator.id));
    expect(preservedCreator?.id).toBe(creator.id);
  });
});

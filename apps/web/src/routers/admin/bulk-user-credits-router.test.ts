import { db } from '@/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { credit_transactions } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';

describe('bulk user credits router', () => {
  it('allows ordinary admins to match users but not grant credits', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const recipient = await insertTestUser();
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.bulkUserCredits.matchUsers({ emails: [recipient.google_user_email] })
    ).resolves.toMatchObject({
      matched: [{ userId: recipient.id }],
      unmatched: [],
    });

    await expect(
      caller.admin.bulkUserCredits.grantBulkCredits({
        emails: [recipient.google_user_email],
        amountUsd: 5,
      })
    ).rejects.toThrow('Credit management access required');

    const transactions = await db
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, recipient.id));
    expect(transactions).toHaveLength(0);
  });

  it('attributes each successful grant to the authenticated credit manager', async () => {
    const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const recipients = await Promise.all([insertTestUser(), insertTestUser()]);
    const missingEmail = `missing-${crypto.randomUUID()}@example.com`;
    const caller = await createCallerForUser(admin.id);

    const results = await caller.admin.bulkUserCredits.grantBulkCredits({
      emails: [...recipients.map(user => user.google_user_email), missingEmail],
      amountUsd: 7,
      description: 'Support adjustment',
    });

    expect(results.filter(result => result.success)).toHaveLength(2);
    expect(results.find(result => result.email === missingEmail)).toMatchObject({ success: false });

    const transactions = await db
      .select({
        kilo_user_id: credit_transactions.kilo_user_id,
        created_by_kilo_user_id: credit_transactions.created_by_kilo_user_id,
        credit_category: credit_transactions.credit_category,
        description: credit_transactions.description,
      })
      .from(credit_transactions)
      .where(
        inArray(
          credit_transactions.kilo_user_id,
          recipients.map(user => user.id)
        )
      );

    expect(transactions).toHaveLength(2);
    expect(transactions).toEqual(
      expect.arrayContaining(
        recipients.map(user => ({
          kilo_user_id: user.id,
          created_by_kilo_user_id: admin.id,
          credit_category: 'admin-bulk-grant',
          description: 'Support adjustment',
        }))
      )
    );
  });
});

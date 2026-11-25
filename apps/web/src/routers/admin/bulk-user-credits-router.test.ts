import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { admin_action_audit_logs, credit_transactions } from '@kilocode/db/schema';
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

  it('records one admin audit row per credited user', async () => {
    const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const recipients = await Promise.all([insertTestUser(), insertTestUser()]);
    const caller = await createCallerForUser(admin.id);

    await caller.admin.bulkUserCredits.grantBulkCredits({
      emails: [
        ...recipients.map(user => user.google_user_email),
        `missing-${crypto.randomUUID()}@example.com`,
      ],
      amountUsd: 3,
    });

    const rows = await db
      .select({
        action: admin_action_audit_logs.action,
        outcome: admin_action_audit_logs.outcome,
        target_type: admin_action_audit_logs.target_type,
        target_id: admin_action_audit_logs.target_id,
        metadata: admin_action_audit_logs.metadata,
      })
      .from(admin_action_audit_logs)
      .where(eq(admin_action_audit_logs.actor_id, admin.id));

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining(
        recipients.map(user => ({
          action: 'credits.bulk_grant',
          outcome: 'success',
          target_type: 'user',
          target_id: user.id,
          metadata: { amountUsd: 3, expirationDate: null },
        }))
      )
    );
  });

  it('distinguishes an invalid expiration date from a past one', async () => {
    const admin = await insertTestUser({ is_admin: true, can_manage_credits: true });
    const recipient = await insertTestUser();
    const caller = await createCallerForUser(admin.id);

    async function refusalMessage(expirationDate: string): Promise<string> {
      let message = '';
      await caller.admin.bulkUserCredits
        .grantBulkCredits({
          emails: [recipient.google_user_email],
          amountUsd: 5,
          expirationDate,
        })
        .catch((error: unknown) => {
          message = error instanceof Error ? error.message : String(error);
        });
      return message;
    }

    const invalidMessage = await refusalMessage('2026-13-01');
    expect(invalidMessage).toContain('Invalid date');
    expect(invalidMessage).not.toContain('must be in the future');

    const pastMessage = await refusalMessage('2024-01-01');
    expect(pastMessage).toContain('Expiration date must be in the future');
    expect(pastMessage).not.toContain('Invalid date');

    const transactions = await db
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(eq(credit_transactions.kilo_user_id, recipient.id));
    expect(transactions).toHaveLength(0);
  });
});

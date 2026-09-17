import { credit_transactions, kilocode_users, organizations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import { and, eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { runExpireCreditsCron } from './credit-expiration-cron';

const now = new Date('2024-06-01T00:00:00.000Z');
const dueAt = '2024-05-01T00:00:00.000Z';
const futureAt = '2024-07-01T00:00:00.000Z';

describe('runExpireCreditsCron', () => {
  const userIds: string[] = [];
  const organizationIds: string[] = [];

  afterEach(async () => {
    if (organizationIds.length > 0) {
      await db
        .delete(credit_transactions)
        .where(inArray(credit_transactions.organization_id, organizationIds));
      await db.delete(organizations).where(inArray(organizations.id, organizationIds));
    }
    if (userIds.length > 0) {
      await db
        .delete(credit_transactions)
        .where(inArray(credit_transactions.kilo_user_id, userIds));
      await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
    }
    userIds.length = 0;
    organizationIds.length = 0;
  });

  it('expires due personal and organization credits and leaves future credits', async () => {
    const dueUser = await insertTestUser({
      total_microdollars_acquired: 1_000,
      microdollars_used: 200,
      next_credit_expiration_at: dueAt,
    });
    const futureUser = await insertTestUser({
      total_microdollars_acquired: 1_000,
      microdollars_used: 0,
      next_credit_expiration_at: futureAt,
    });
    userIds.push(dueUser.id, futureUser.id);

    await db.insert(credit_transactions).values([
      {
        kilo_user_id: dueUser.id,
        amount_microdollars: 1_000,
        is_free: true,
        expiry_date: dueAt,
        expiration_baseline_microdollars_used: 0,
        original_baseline_microdollars_used: 0,
        description: 'Due personal credits',
      },
      {
        kilo_user_id: futureUser.id,
        amount_microdollars: 1_000,
        is_free: true,
        expiry_date: futureAt,
        expiration_baseline_microdollars_used: 0,
        original_baseline_microdollars_used: 0,
        description: 'Future personal credits',
      },
    ]);

    const dueOrg = await createOrganization(
      `expire-credits-${randomUUID().slice(0, 8)}`,
      dueUser.id
    );
    const futureOrg = await createOrganization(
      `expire-credits-future-${randomUUID().slice(0, 8)}`,
      futureUser.id
    );
    organizationIds.push(dueOrg.id, futureOrg.id);
    await db
      .update(organizations)
      .set({
        total_microdollars_acquired: 1_000,
        microdollars_used: 100,
        microdollars_balance: 900,
        next_credit_expiration_at: dueAt,
      })
      .where(eq(organizations.id, dueOrg.id));
    await db
      .update(organizations)
      .set({
        total_microdollars_acquired: 1_000,
        microdollars_used: 0,
        microdollars_balance: 1_000,
        next_credit_expiration_at: futureAt,
      })
      .where(eq(organizations.id, futureOrg.id));
    await db.insert(credit_transactions).values([
      {
        kilo_user_id: dueUser.id,
        organization_id: dueOrg.id,
        amount_microdollars: 1_000,
        is_free: true,
        expiry_date: dueAt,
        expiration_baseline_microdollars_used: 0,
        original_baseline_microdollars_used: 0,
        description: 'Due organization credits',
      },
      {
        kilo_user_id: futureUser.id,
        organization_id: futureOrg.id,
        amount_microdollars: 1_000,
        is_free: true,
        expiry_date: futureAt,
        expiration_baseline_microdollars_used: 0,
        original_baseline_microdollars_used: 0,
        description: 'Future organization credits',
      },
    ]);

    const summary = await runExpireCreditsCron({
      now,
      userIds,
      organizationIds,
    });

    expect(summary).toEqual({
      usersExamined: 1,
      usersFailed: 0,
      organizationsExamined: 1,
      organizationsFailed: 0,
      hasMore: false,
    });

    const [updatedDueUser] = await db
      .select({
        total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
        next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, dueUser.id));
    expect(updatedDueUser?.total_microdollars_acquired).toBe(200);
    expect(updatedDueUser?.next_credit_expiration_at).toBeNull();

    const [updatedFutureUser] = await db
      .select({
        total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
        next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
      })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, futureUser.id));
    expect(updatedFutureUser?.total_microdollars_acquired).toBe(1_000);
    expect(updatedFutureUser?.next_credit_expiration_at).not.toBeNull();
    expect(new Date(updatedFutureUser!.next_credit_expiration_at!).toISOString()).toBe(futureAt);

    const [updatedDueOrg] = await db
      .select({
        total_microdollars_acquired: organizations.total_microdollars_acquired,
        next_credit_expiration_at: organizations.next_credit_expiration_at,
      })
      .from(organizations)
      .where(eq(organizations.id, dueOrg.id));
    expect(updatedDueOrg?.total_microdollars_acquired).toBe(100);
    expect(updatedDueOrg?.next_credit_expiration_at).toBeNull();

    const futureOrgCredits = await db
      .select({ id: credit_transactions.id })
      .from(credit_transactions)
      .where(
        and(
          eq(credit_transactions.organization_id, futureOrg.id),
          eq(credit_transactions.credit_category, 'credits_expired')
        )
      );
    expect(futureOrgCredits).toHaveLength(0);
  });

  it('pages due rows that share an expiration timestamp', async () => {
    const firstUser = await insertTestUser({
      total_microdollars_acquired: 500,
      microdollars_used: 0,
      next_credit_expiration_at: dueAt,
    });
    const secondUser = await insertTestUser({
      total_microdollars_acquired: 700,
      microdollars_used: 0,
      next_credit_expiration_at: dueAt,
    });
    userIds.push(firstUser.id, secondUser.id);
    await db.insert(credit_transactions).values([
      {
        kilo_user_id: firstUser.id,
        amount_microdollars: 500,
        is_free: true,
        expiry_date: dueAt,
        expiration_baseline_microdollars_used: 0,
        original_baseline_microdollars_used: 0,
        description: 'First shared expiry',
      },
      {
        kilo_user_id: secondUser.id,
        amount_microdollars: 700,
        is_free: true,
        expiry_date: dueAt,
        expiration_baseline_microdollars_used: 0,
        original_baseline_microdollars_used: 0,
        description: 'Second shared expiry',
      },
    ]);

    const summary = await runExpireCreditsCron({
      now,
      userIds,
      organizationIds: [],
      userBatchSize: 1,
    });

    expect(summary.usersExamined).toBe(2);
    expect(summary.usersFailed).toBe(0);
    expect(summary.hasMore).toBe(false);

    const updated = await db
      .select({
        id: kilocode_users.id,
        next_credit_expiration_at: kilocode_users.next_credit_expiration_at,
      })
      .from(kilocode_users)
      .where(inArray(kilocode_users.id, userIds));
    expect(updated.every(user => user.next_credit_expiration_at === null)).toBe(true);
  });
});

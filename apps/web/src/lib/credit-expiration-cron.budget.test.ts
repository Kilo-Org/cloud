import { credit_transactions, kilocode_users, organizations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

const mockClockState = { userProcessingStarted: false };

jest.mock('@/lib/creditExpiration', () => {
  const actual = jest.requireActual('@/lib/creditExpiration');
  return {
    ...actual,
    processLocalExpirations: jest.fn(async () => {
      mockClockState.userProcessingStarted = true;
      return null;
    }),
  };
});

import { runExpireCreditsCron } from './credit-expiration-cron';

const now = new Date('2024-06-01T00:00:00.000Z');
const dueAt = '2024-05-01T00:00:00.000Z';
const startedAt = 1_000_000;
const timeBudgetMs = 45_000;

describe('runExpireCreditsCron budget split', () => {
  const userIds: string[] = [];
  const organizationIds: string[] = [];

  afterEach(async () => {
    mockClockState.userProcessingStarted = false;
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

  it('expires organizations before user processing can exhaust the time budget', async () => {
    const user = await insertTestUser({
      total_microdollars_acquired: 1_000,
      microdollars_used: 0,
      next_credit_expiration_at: dueAt,
    });
    userIds.push(user.id);
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      amount_microdollars: 1_000,
      is_free: true,
      expiry_date: dueAt,
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Due personal credits',
    });

    const organization = await createOrganization(
      `expire-credits-budget-${randomUUID().slice(0, 8)}`,
      user.id
    );
    organizationIds.push(organization.id);
    await db
      .update(organizations)
      .set({
        total_microdollars_acquired: 1_000,
        microdollars_used: 0,
        microdollars_balance: 1_000,
        next_credit_expiration_at: dueAt,
      })
      .where(eq(organizations.id, organization.id));
    await db.insert(credit_transactions).values({
      kilo_user_id: user.id,
      organization_id: organization.id,
      amount_microdollars: 1_000,
      is_free: true,
      expiry_date: dueAt,
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
      description: 'Due organization credits',
    });

    const summary = await runExpireCreditsCron({
      now,
      userIds,
      organizationIds,
      timeBudgetMs,
      clock: () =>
        mockClockState.userProcessingStarted ? startedAt + timeBudgetMs + 1 : startedAt + 1,
    });

    expect(summary.organizationsExamined).toBe(1);
    expect(summary.organizationsFailed).toBe(0);
    const [updatedOrganization] = await db
      .select({
        total_microdollars_acquired: organizations.total_microdollars_acquired,
      })
      .from(organizations)
      .where(eq(organizations.id, organization.id));
    expect(updatedOrganization?.total_microdollars_acquired).toBe(0);
  });
});

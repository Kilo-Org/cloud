import { after } from 'next/server';
import { eq } from 'drizzle-orm';
import { credit_transactions, kilocode_users, organizations } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  maybePerformAutoTopUp,
  maybePerformOrganizationAutoTopUp,
} from '@kilocode/web-shared/lib/autoTopUp';
import { getBalanceForUser } from '@kilocode/web-shared/lib/user/balance';
import {
  getBalanceAndOrgSettings,
  getBalanceForOrganizationUser,
  ingestOrganizationTokenUsage,
  updateOrganizationUserLimit,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { defineMicrodollarUsage } from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';
import { insertUsageRecord } from '@kilocode/web-shared/lib/ai-gateway/processUsage';

jest.mock('@kilocode/web-shared/lib/autoTopUp', () => ({
  maybePerformAutoTopUp: jest.fn(async () => undefined),
  maybePerformOrganizationAutoTopUp: jest.fn(async () => undefined),
}));

jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn(),
}));

async function finishDeferredWork(): Promise<void> {
  for (const [callback] of jest.mocked(after).mock.calls) {
    if (typeof callback === 'function') await callback();
    else await callback;
  }
  jest.mocked(after).mockClear();
}

beforeEach(() => {
  jest.clearAllMocks();
});

async function createExpiringPayer(organization: boolean) {
  const expiry = new Date(Date.now() - 60_000).toISOString();
  const user = await insertTestUser({
    auto_top_up_enabled: true,
    total_microdollars_acquired: 10_000_000,
    microdollars_used: 0,
    next_credit_expiration_at: organization ? null : expiry,
  });
  const org = organization
    ? await createTestOrganization('Funding boundary', user.id, 10_000_000, undefined, false)
    : undefined;
  if (org) {
    await db
      .update(organizations)
      .set({
        auto_top_up_enabled: true,
        next_credit_expiration_at: expiry,
      })
      .where(eq(organizations.id, org.id));
  }
  await db.insert(credit_transactions).values({
    kilo_user_id: user.id,
    organization_id: org?.id ?? null,
    amount_microdollars: 10_000_000,
    is_free: false,
    expiry_date: expiry,
    expiration_baseline_microdollars_used: 0,
    original_baseline_microdollars_used: 0,
    description: 'Paid credits due one minute ago',
  });
  return { user, org };
}

describe('balance reads and usage funding', () => {
  test('viewing or refreshing a personal balance expires due principal without funding', async () => {
    const { user } = await createExpiringPayer(false);
    expect(await getBalanceForUser(user)).toEqual({ balance: 0 });
    expect(await getBalanceForUser(user, { forceRefresh: true })).toEqual({ balance: 0 });
    await finishDeferredWork();
    expect(maybePerformAutoTopUp).not.toHaveBeenCalled();
    expect(maybePerformOrganizationAutoTopUp).not.toHaveBeenCalled();
  });

  test('expiration combines the primary usage snapshot with its acquired-credit adjustment', async () => {
    const { user } = await createExpiringPayer(false);
    await db
      .update(kilocode_users)
      .set({ microdollars_used: 4_000_000 })
      .where(eq(kilocode_users.id, user.id));
    expect(await getBalanceForUser(user)).toEqual({ balance: 0 });
    await finishDeferredWork();
    expect(maybePerformAutoTopUp).not.toHaveBeenCalled();
  });

  test('viewing organization balances expires due principal without funding', async () => {
    const { user, org } = await createExpiringPayer(true);
    if (!org) throw new Error('Organization fixture missing');
    expect((await getBalanceForOrganizationUser(org.id, user.id)).balance).toBe(0);
    expect((await getBalanceAndOrgSettings(org.id, user)).balance).toBe(0);
    await finishDeferredWork();
    expect(maybePerformOrganizationAutoTopUp).not.toHaveBeenCalled();
    expect(maybePerformAutoTopUp).not.toHaveBeenCalled();
  });

  test.each([false, true])(
    'a requested paid admission can fund after expiry (organization=%s)',
    async organization => {
      const { user, org } = await createExpiringPayer(organization);
      expect((await getBalanceAndOrgSettings(org?.id, user, undefined, 'usage')).balance).toBe(0);
      await finishDeferredWork();
      const funding = org ? maybePerformOrganizationAutoTopUp : maybePerformAutoTopUp;
      expect(funding).toHaveBeenCalledTimes(1);
      expect(funding).toHaveBeenCalledWith(
        expect.objectContaining({
          id: org?.id ?? user.id,
          total_microdollars_acquired: 0,
          microdollars_used: 0,
          auto_top_up_enabled: true,
        })
      );
    }
  );

  test('an exhausted organization member allowance cannot cause a payment', async () => {
    const { user, org } = await createExpiringPayer(true);
    if (!org) throw new Error('Organization fixture missing');
    await updateOrganizationUserLimit(org.id, user.id, 0);
    const balance = await getBalanceAndOrgSettings(org.id, user, undefined, 'usage');
    expect(balance.balanceLimitedByUserAllowance).toBe(true);
    await finishDeferredWork();
    expect(maybePerformOrganizationAutoTopUp).not.toHaveBeenCalled();
  });

  test.each([0, -500, 500])('organization usage funds only a positive debit (%s)', async cost => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Usage funding', user.id, 1_000);
    await db
      .update(organizations)
      .set({ auto_top_up_enabled: true })
      .where(eq(organizations.id, org.id));
    const { core } = await defineMicrodollarUsage();
    await ingestOrganizationTokenUsage({
      ...core,
      kilo_user_id: user.id,
      organization_id: org.id,
      cost,
    });
    await finishDeferredWork();
    expect(maybePerformOrganizationAutoTopUp).toHaveBeenCalledTimes(cost > 0 ? 1 : 0);
    if (cost > 0) {
      expect(maybePerformOrganizationAutoTopUp).toHaveBeenCalledWith(
        expect.objectContaining({
          id: org.id,
          microdollars_used: cost,
          total_microdollars_acquired: 1_000,
        })
      );
    }
  });

  test.each([
    { organization: false, cost: 0 },
    { organization: false, cost: 500 },
    { organization: true, cost: 0 },
    { organization: true, cost: 500 },
  ])(
    'committed usage funds once, never on replay or free usage ($organization, $cost)',
    async ({ organization, cost }) => {
      const user = await insertTestUser({ auto_top_up_enabled: true });
      const org = organization
        ? await createTestOrganization('Committed usage', user.id, 1_000)
        : undefined;
      if (org) {
        await db
          .update(organizations)
          .set({ auto_top_up_enabled: true })
          .where(eq(organizations.id, org.id));
      }
      const funding = org ? maybePerformOrganizationAutoTopUp : maybePerformAutoTopUp;
      const { core, metadata } = await defineMicrodollarUsage();
      const usage = { ...core, kilo_user_id: user.id, organization_id: org?.id ?? null, cost };
      expect(await insertUsageRecord(usage, metadata)).toMatchObject({ wasRedelivery: false });
      await finishDeferredWork();
      expect(funding).toHaveBeenCalledTimes(cost > 0 ? 1 : 0);
      expect(await insertUsageRecord(usage, metadata)).toMatchObject({ wasRedelivery: true });
      await finishDeferredWork();
      expect(funding).toHaveBeenCalledTimes(cost > 0 ? 1 : 0);
    }
  );

  test('usage admission preserves an explicit auto-top-up opt-out', async () => {
    const user = await insertTestUser({
      auto_top_up_enabled: false,
      total_microdollars_acquired: 0,
    });
    await getBalanceAndOrgSettings(undefined, user, undefined, 'usage');
    await finishDeferredWork();
    expect(maybePerformAutoTopUp).not.toHaveBeenCalled();
  });
});

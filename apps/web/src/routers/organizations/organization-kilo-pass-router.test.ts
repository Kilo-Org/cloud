import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Organization, User } from '@kilocode/db/schema';
import { organization_memberships, organizations } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import type { OrganizationKiloPassService } from '@/lib/kilo-pass-org/service';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
import type { createCallerForUser as TestCallerFactory } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';

const getSummary = jest.fn<OrganizationKiloPassService['getSummary']>();
const getSetup = jest.fn<OrganizationKiloPassService['getSetup']>();
const getDetail = jest.fn<OrganizationKiloPassService['getDetail']>();
const getUsage = jest.fn<OrganizationKiloPassService['getUsage']>();
const createCheckout = jest.fn<OrganizationKiloPassService['createCheckout']>();
const updateAllocation = jest.fn<OrganizationKiloPassService['updateAllocation']>();
const cancel = jest.fn<OrganizationKiloPassService['cancel']>();

jest.mock('@/lib/kilo-pass-org/stripe-adapter', () => ({
  createOrganizationKiloPassCheckout: jest.fn(),
  resumeOrganizationKiloPassCancellation: jest.fn(),
  scheduleOrganizationKiloPassCancellation: jest.fn(),
}));

jest.mock('@/lib/kilo-pass-org/service', () => ({
  organizationKiloPassService: {
    getSummary,
    getSetup,
    getDetail,
    getUsage,
    createCheckout,
    updateAllocation,
    cancel,
  },
}));

const NOW = '2026-07-23T12:00:00.000Z';

describe('organization Kilo Pass router', () => {
  let createCallerForUser: typeof TestCallerFactory;
  let owner: User;
  let billingManager: User;
  let member: User;
  let childOwner: User;
  let unrelated: User;
  let parent: Organization;
  let child: Organization;
  let unrelatedOrganization: Organization;

  beforeAll(async () => {
    ({ createCallerForUser } = await import('@/routers/test-utils'));
    owner = await insertTestUser({
      google_user_email: `kp-owner-${crypto.randomUUID()}@example.com`,
    });
    billingManager = await insertTestUser({
      google_user_email: `kp-billing-${crypto.randomUUID()}@example.com`,
    });
    member = await insertTestUser({
      google_user_email: `kp-member-${crypto.randomUUID()}@example.com`,
    });
    childOwner = await insertTestUser({
      google_user_email: `kp-child-owner-${crypto.randomUUID()}@example.com`,
    });
    unrelated = await insertTestUser({
      google_user_email: `kp-unrelated-${crypto.randomUUID()}@example.com`,
    });
    parent = await createOrganization('Kilo Pass parent', owner.id);
    child = await createOrganization('Kilo Pass child', childOwner.id);
    unrelatedOrganization = await createOrganization('Kilo Pass unrelated', unrelated.id);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    await addUserToOrganization(parent.id, billingManager.id, 'billing_manager');
    await addUserToOrganization(parent.id, member.id, 'member');
  });

  afterAll(async () => {
    const organizationIds = [parent.id, child.id, unrelatedOrganization.id];
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, organizationIds));
    await db
      .update(organizations)
      .set({ parent_organization_id: null })
      .where(eq(organizations.id, child.id));
    await db.delete(organizations).where(inArray(organizations.id, organizationIds));
  });

  beforeEach(() => {
    for (const mock of [
      getSummary,
      getSetup,
      getDetail,
      getUsage,
      createCheckout,
      updateAllocation,
      cancel,
    ]) {
      mock.mockReset();
    }
    getSummary.mockResolvedValue({
      state: 'unavailable',
      commercialState: null,
      processingCondition: null,
      agreement: null,
    });
    getSetup.mockResolvedValue({
      paidSeatCount: 2,
      cadence: 'monthly',
      renewalAt: NOW,
      planVersion: 0,
      children: [{ id: child.id, name: child.name }],
      terms: [
        {
          tier: 'tier_19',
          tierName: 'Starter',
          pricePerPassUsd: 19,
          baseCreditsPerPassUsd: 19,
          bonusCreditsPerPassUsd: 4,
          unlockSpendPerPassUsd: 19,
          bonusMode: 'after_base',
        },
      ],
    });
    getDetail.mockResolvedValue({
      state: 'active',
      commercialState: 'active',
      processingCondition: 'ready',
      tier: 'tier_19',
      cadence: 'monthly',
      terms: {
        tier: 'tier_19',
        tierName: 'Starter',
        pricePerPassUsd: 19,
        baseCreditsPerPassUsd: 19,
        bonusCreditsPerPassUsd: 4,
        unlockSpendPerPassUsd: 19,
        bonusMode: 'after_base',
      },
      paidSeatCount: 2,
      nextPaidSeatCount: 2,
      planVersion: 1,
      paidThrough: NOW,
      currentWindow: { startsAt: NOW, endsAt: '2026-08-23T12:00:00.000Z' },
      nextWindowStartsAt: '2026-08-23T12:00:00.000Z',
      latestRun: null,
      currentAllocations: [
        {
          organizationId: parent.id,
          organizationName: parent.name,
          passCount: 1,
          kind: 'parent',
          hasProratedCredits: false,
          baseCreditsMicrodollars: 19_000_000,
          qualifyingSpendMicrodollars: 0,
          unlockTargetMicrodollars: 19_000_000,
          bonusCreditsMicrodollars: 4_000_000,
          bonusState: 'locked',
        },
      ],
      nextAllocations: [
        { organizationId: parent.id, organizationName: parent.name, passCount: 1, kind: 'parent' },
        { organizationId: child.id, organizationName: child.name, passCount: 1, kind: 'child' },
      ],
    });
    getUsage.mockResolvedValue(null);
    createCheckout.mockResolvedValue({ kind: 'payment_action', clientSecret: 'pi_secret_1' });
    updateAllocation.mockResolvedValue({ planVersion: 2, nextWindowStartsAt: NOW });
    cancel.mockResolvedValue({ state: 'cancel_at_period_end', effectiveAt: NOW });
  });

  it('allows an owner and billing manager to read parent agreement data', async () => {
    const ownerCaller = await createCallerForUser(owner.id);
    const billingCaller = await createCallerForUser(billingManager.id);

    await expect(
      ownerCaller.organizations.kiloPass.summary({ organizationId: parent.id })
    ).resolves.toEqual({
      state: 'unavailable',
      commercialState: null,
      processingCondition: null,
      agreement: null,
    });
    await expect(
      billingCaller.organizations.kiloPass.detail({ organizationId: parent.id })
    ).resolves.toMatchObject({
      state: 'active',
      commercialState: 'active',
      processingCondition: 'ready',
    });
  });

  it('allows billing roles to read Kilo Pass usage and denies regular members', async () => {
    const detail = await getDetail({ organizationId: parent.id });
    getUsage.mockResolvedValue({
      tier: detail.tier,
      terms: detail.terms,
      currentWindow: detail.currentWindow!,
      currentAllocations: detail.currentAllocations,
    });
    const billingCaller = await createCallerForUser(billingManager.id);
    const memberCaller = await createCallerForUser(member.id);

    await expect(
      billingCaller.organizations.kiloPass.usage({ organizationId: parent.id })
    ).resolves.toMatchObject({ tier: 'tier_19' });
    await expect(
      memberCaller.organizations.kiloPass.usage({ organizationId: parent.id })
    ).rejects.toThrow('required organizational role');
  });

  it.each([
    ['member', () => member.id, () => parent.id, 'required organizational role'],
    ['child owner', () => childOwner.id, () => child.id, 'parent organization'],
    ['unrelated user', () => unrelated.id, () => parent.id, 'do not have access'],
  ])('denies a %s', async (_label, userId, organizationId, message) => {
    const caller = await createCallerForUser(userId());
    await expect(
      caller.organizations.kiloPass.summary({ organizationId: organizationId() })
    ).rejects.toThrow(message);
  });

  it('passes a payment-action result through the Stripe-free checkout boundary', async () => {
    const caller = await createCallerForUser(owner.id);
    await expect(
      caller.organizations.kiloPass.createCheckout({
        organizationId: parent.id,
        tier: 'tier_49',
        allocations: [{ childOrganizationId: child.id, passCount: 2 }],
      })
    ).resolves.toEqual({ kind: 'payment_action', clientSecret: 'pi_secret_1' });
    expect(createCheckout).toHaveBeenCalledWith(
      {
        organizationId: parent.id,
        actorUserId: owner.id,
        tier: 'tier_49',
        allocations: [{ childOrganizationId: child.id, passCount: 2 }],
      },
      expect.any(Function)
    );
  });

  it('rejects duplicate allocations before calling the service', async () => {
    const caller = await createCallerForUser(owner.id);
    await expect(
      caller.organizations.kiloPass.createCheckout({
        organizationId: parent.id,
        tier: 'tier_19',
        allocations: [
          { childOrganizationId: child.id, passCount: 1 },
          { childOrganizationId: child.id, passCount: 1 },
        ],
      })
    ).rejects.toThrow('Each child organization can appear at most once');
    expect(createCheckout).not.toHaveBeenCalled();
  });

  it('maps a stale plan service conflict to tRPC CONFLICT', async () => {
    updateAllocation.mockRejectedValue(new Error('STALE_PLAN_VERSION'));
    const caller = await createCallerForUser(owner.id);
    await expect(
      caller.organizations.kiloPass.updateAllocation({
        organizationId: parent.id,
        expectedPlanVersion: 1,
        allocations: [{ childOrganizationId: child.id, passCount: 1 }],
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

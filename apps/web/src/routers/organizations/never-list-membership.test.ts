/* eslint-disable drizzle/enforce-delete-with-where */
import { afterAll, afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import {
  kilocode_users,
  organization_memberships,
  organizations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCallerForUser } from '@/routers/test-utils';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

type Caller = Awaited<ReturnType<typeof createCallerForUser>>;

// Payments, Stripe billing sessions and the worktree chat credential are on the
// support never-list: only a real (direct or inherited) membership with the
// procedure's own roles passes, whatever the support switch says. A platform
// admin without a membership gets the ordinary non-member refusal.
const NEVER_LIST_CALLS: ReadonlyArray<
  [key: string, call: (caller: Caller, organizationId: string) => Promise<unknown>]
> = [
  [
    'organizations.autoTopUp.toggle',
    (c, organizationId) =>
      c.organizations.autoTopUp.toggle({ organizationId, currentEnabled: false }),
  ],
  [
    'organizations.autoTopUp.changePaymentMethod',
    (c, organizationId) => c.organizations.autoTopUp.changePaymentMethod({ organizationId }),
  ],
  [
    'organizations.autoTopUp.updateAmount',
    (c, organizationId) =>
      c.organizations.autoTopUp.updateAmount({ organizationId, amountCents: 50000 }),
  ],
  [
    'organizations.autoTopUp.updateThreshold',
    (c, organizationId) =>
      c.organizations.autoTopUp.updateThreshold({ organizationId, thresholdCents: 5000 }),
  ],
  [
    'organizations.autoTopUp.removePaymentMethod',
    (c, organizationId) => c.organizations.autoTopUp.removePaymentMethod({ organizationId }),
  ],
  [
    'organizations.subscription.getSubscriptionStripeUrl',
    (c, organizationId) =>
      c.organizations.subscription.getSubscriptionStripeUrl({
        organizationId,
        seats: 1,
        cancelUrl: 'https://example.com/cancel',
        billingCycle: 'monthly',
      }),
  ],
  [
    'organizations.subscription.cancel',
    (c, organizationId) => c.organizations.subscription.cancel({ organizationId }),
  ],
  [
    'organizations.subscription.updateSeatCount',
    (c, organizationId) =>
      c.organizations.subscription.updateSeatCount({ organizationId, newSeatCount: 2 }),
  ],
  [
    'organizations.subscription.getCustomerPortalUrl',
    (c, organizationId) => c.organizations.subscription.getCustomerPortalUrl({ organizationId }),
  ],
  [
    'organizations.subscription.changeBillingCycle',
    (c, organizationId) =>
      c.organizations.subscription.changeBillingCycle({ organizationId, targetCycle: 'annual' }),
  ],
  [
    'organizations.kiloPass.createCheckout',
    (c, organizationId) =>
      c.organizations.kiloPass.createCheckout({ organizationId, tier: 'tier_19', allocations: [] }),
  ],
  [
    'organizations.kiloPass.cancel',
    (c, organizationId) => c.organizations.kiloPass.cancel({ organizationId }),
  ],
  [
    'organizations.cloudAgentNext.createWorktreeChat',
    (c, organizationId) =>
      c.organizations.cloudAgentNext.createWorktreeChat({
        organizationId,
        sourceKiloSessionId: 'ses_12345678901234567890123456',
        operationKey: '12345678-1234-4234-9234-123456789abc',
      }),
  ],
];

const BILLING_ONLY = NEVER_LIST_CALLS.filter(
  ([key]) => key !== 'organizations.cloudAgentNext.createWorktreeChat'
);

describe.each(['false', 'true'])('never-list tRPC procedures (support access %s)', support => {
  let owner: User;
  let member: User;
  let admin: User;
  let organization: Organization;
  const previousSupport = process.env.SUPPORT_ACCESS_ENABLED;

  beforeAll(async () => {
    process.env.SUPPORT_ACCESS_ENABLED = support;
    owner = await insertTestUser();
    member = await insertTestUser();
    admin = await insertTestUser({ is_admin: true });
    organization = await createTestOrganization('Never-list membership', owner.id, 0);
    await db
      .insert(organization_memberships)
      .values({ organization_id: organization.id, kilo_user_id: member.id, role: 'member' });
  });

  afterEach(() => {
    process.env.SUPPORT_ACCESS_ENABLED = support;
  });

  afterAll(async () => {
    process.env.SUPPORT_ACCESS_ENABLED = previousSupport;
    await db.delete(organizations);
    await db.delete(kilocode_users);
  });

  it.each(NEVER_LIST_CALLS)(
    '%s refuses a platform admin without a membership',
    async (_key, call) => {
      const caller = await createCallerForUser(admin.id);
      await expect(call(caller, organization.id)).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
        message: 'You do not have access to this organization',
      });
    }
  );

  it.each(BILLING_ONLY)('%s keeps refusing an ordinary member', async (_key, call) => {
    const caller = await createCallerForUser(member.id);
    await expect(call(caller, organization.id)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});

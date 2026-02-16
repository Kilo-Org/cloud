import type { Organization, User } from '@/db/schema';
import { organizations, credit_transactions } from '@/db/schema';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { db } from '@/lib/drizzle';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { createStripeCustomer } from '@/lib/stripe-client';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type Stripe from 'stripe';
import type { StripeConfig } from '@/lib/credits';
import { toMicrodollars } from '@/lib/utils';
import { logExceptInTest } from '@/lib/utils.server';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { grantEntityCreditForCategory } from '@/lib/promotionalCredits';
import { findUserById } from '@/lib/user';
import { SYSTEM_AUTO_TOP_UP_USER_ID } from '@/lib/autoTopUpConstants';

export async function getOrCreateStripeCustomerIdForOrganization(
  organizationId: Organization['id'],
  mockCreateStripeCustomer?: (params: {
    metadata: { organizationId: string };
  }) => Promise<Stripe.Customer>
): Promise<string> {
  const org = await getOrganizationById(organizationId);
  if (!org) {
    throw new Error('Organization not found');
  }
  if (org.stripe_customer_id != null) {
    logExceptInTest(
      `Found existing Stripe customer ID for organization ${organizationId}: ${org.stripe_customer_id}`
    );
    return org.stripe_customer_id;
  }
  const stripeCustomerFn = mockCreateStripeCustomer || createStripeCustomer;

  const customer = await stripeCustomerFn({
    metadata: {
      organizationId,
    },
  });

  const rows = await db
    .update(organizations)
    .set({ stripe_customer_id: customer.id })
    .where(and(eq(organizations.id, organizationId), isNull(organizations.stripe_customer_id)))
    .returning();

  if (!rows.length || !rows[0].stripe_customer_id) {
    throw new Error('Failed to create Stripe customer for organization');
  }
  return rows[0].stripe_customer_id;
}

type Config = StripeConfig;

export async function processTopupForOrganization(
  kiloUserId: User['id'],
  organizationId: Organization['id'],
  amountInCents: number,
  config: Config
) {
  const organization = await getOrganizationById(organizationId);
  if (!organization) throw new Error('Organization not found: ' + organizationId);

  let user: User | undefined;
  if (kiloUserId !== SYSTEM_AUTO_TOP_UP_USER_ID) {
    user = (await findUserById(kiloUserId)) ?? undefined;
    if (!user) {
      logExceptInTest(`User ${kiloUserId} not found for organization top-up ${organizationId}`);
    }
  }

  const creditDescription = `Organization top-up via ${config.type}`;
  const creditAmountInMicrodollars = toMicrodollars(amountInCents / 100);

  await db.transaction(async (tx: DrizzleTransaction) => {
    logExceptInTest(
      `processing topup for ${organization.id} - ${amountInCents} in transaction with payment id ${config.stripe_payment_id}`
    );

    const result = await tx
      .insert(credit_transactions)
      .values({
        kilo_user_id: kiloUserId,
        organization_id: organization.id,
        is_free: false,
        amount_microdollars: creditAmountInMicrodollars,
        description: creditDescription,
        stripe_payment_id: config.stripe_payment_id,
        original_baseline_microdollars_used: organization.microdollars_used,
      })
      .onConflictDoNothing();

    if (result.rowCount === 0) {
      logExceptInTest(
        `Skipping duplicate topup for ${organization.id} - payment id ${config.stripe_payment_id} already processed`
      );
      return;
    }

    // Update organization balance
    await tx
      .update(organizations)
      .set({
        total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} + ${Math.round(creditAmountInMicrodollars)}`,
      })
      .where(eq(organizations.id, organization.id));
  });
  await createAuditLog({
    action: 'organization.purchase_credits',
    actor_id: kiloUserId,
    actor_email: user?.google_user_email || 'unknown',
    actor_name: user?.google_user_name || 'unknown',
    organization_id: organization.id,
    message: `Purchased $${(amountInCents / 100).toFixed(2)} credit via ${config.type}`,
  });

  if (process.env.NODE_ENV === 'test') {
    // 2025-12-03: temporarily disable this promo until devrel decides it's time to go live with it.
    if (user) {
      await grantEntityCreditForCategory(
        { organization, user },
        { credit_category: 'team-topup-bonus-2025', counts_as_selfservice: false }
      );
    }
  }
}

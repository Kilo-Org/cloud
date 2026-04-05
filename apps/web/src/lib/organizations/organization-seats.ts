import type { Organization, OrganizationSeatsPurchase } from '@kilocode/db/schema';
import {
  organization_seats_purchases,
  organization_membership_removals,
  organizations,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { eq, desc, and, sql } from 'drizzle-orm';
import * as z from 'zod';
import type Stripe from 'stripe';
import {
  addUserToOrganization,
  getOrganizationMembers,
  getOrganizationById,
} from '@/lib/organizations/organizations';
import { errorExceptInTest, logExceptInTest, sentryLogger } from '@/lib/utils.server';
import { captureException } from '@sentry/nextjs';
import PostHogClient from '@/lib/posthog';
import { findUserById } from '@/lib/user';
import { after } from 'next/server';
import { sendOrgCancelledEmail, sendOrgRenewedEmail, sendOrgSubscriptionEmail } from '@/lib/email';
import { IS_IN_AUTOMATED_TEST } from '@/lib/config.server';
import type { OrganizationPlan } from '@/lib/organizations/organization-types';
import {
  OrganizationPlanSchema,
  billingCycleFromStripeInterval,
  billingCycleToDb,
} from '@/lib/organizations/organization-types';
import { client as stripeClient } from '@/lib/stripe-client';

const sentryError = sentryLogger('organization_seats', 'error');

const SubscriptionMetadataSchema = z.object({
  type: z.string(),
  kiloUserId: z.string(),
  organizationId: z.string(),
  seats: z
    .string()
    .transform((val, ctx) => {
      const parsed = Number(val);
      if (isNaN(parsed)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'seats must be a valid number',
        });
        return z.NEVER;
      }
      return parsed;
    })
    .pipe(z.number().int().positive()),
  // Accept any string for planType — validated separately via getPlanTypeFromSubscription()
  // to avoid rejecting the entire event on invalid values (Org Plans 7).
  planType: z.string().optional(),
});

export type SubscriptionMetadata = z.infer<typeof SubscriptionMetadataSchema>;

/**
 * Returns the most recently created seat purchase for an organization.
 *
 * organization_seats_purchases is append-only: every subscription event
 * (creation, renewal, cancellation) inserts a new row.  The most recently
 * created row therefore always reflects the current subscription state.
 */
export async function getMostRecentSeatPurchase(
  organizationId: Organization['id']
): Promise<OrganizationSeatsPurchase | null> {
  const [purchase] = await db
    .select()
    .from(organization_seats_purchases)
    .where(eq(organization_seats_purchases.organization_id, organizationId))
    .orderBy(desc(organization_seats_purchases.created_at))
    .limit(1);

  return purchase || null;
}

/** Returns the most recently ended seat purchase by period end. Used for resubscribe flow. */
export async function getMostRecentEndedSeatPurchase(
  organizationId: Organization['id']
): Promise<OrganizationSeatsPurchase | null> {
  const [purchase] = await db
    .select()
    .from(organization_seats_purchases)
    .where(
      and(
        eq(organization_seats_purchases.organization_id, organizationId),
        eq(organization_seats_purchases.subscription_status, 'ended')
      )
    )
    .orderBy(desc(organization_seats_purchases.expires_at))
    .limit(1);

  return purchase || null;
}

export async function getOrganizationSeatUsage(
  organizationId: Organization['id']
): Promise<{ used: number; total: number }> {
  const [members, organization] = await Promise.all([
    getOrganizationMembers(organizationId),
    getOrganizationById(organizationId),
  ]);
  // Exclude billing_manager role from seat count
  const used = members.filter(m => m.role !== 'billing_manager').length;
  const total = organization?.seat_count || 0;
  return { used, total };
}

/**
 * Determines the organization plan type from a Stripe subscription metadata.
 * Returns null if planType is not present in subscription metadata.
 * If planType is missing, the organization's plan will not be updated (only seat_count will be updated).
 */
function getPlanTypeFromSubscription(subscription: Stripe.Subscription): OrganizationPlan | null {
  const planTypeFromSubscriptionMetadata = subscription.metadata?.planType;
  if (!planTypeFromSubscriptionMetadata) {
    // If planType doesn't exist in metadata, return null (do nothing - works as it used to)
    return null;
  }

  const validationResult = OrganizationPlanSchema.safeParse(planTypeFromSubscriptionMetadata);
  if (validationResult.success) {
    return validationResult.data;
  }

  // If planType exists but is invalid, log and return null
  sentryError(
    `Invalid planType value in subscription ${subscription.id} metadata: ${planTypeFromSubscriptionMetadata}`,
    {
      subscription_id: subscription.id,
      planType_from_metadata: planTypeFromSubscriptionMetadata,
    }
  );
  return null;
}

async function handleSubscriptionEventInternal(
  subscription: Stripe.Subscription,
  idempotencyKey?: string,
  isCreation = false
) {
  const meta = SubscriptionMetadataSchema.parse(subscription.metadata);
  logExceptInTest(
    `handling subscription event for ${subscription.id} for org ${meta.organizationId}`
  );

  // Reject events for deleted organizations (Error Handling 9)
  const organization = await getOrganizationById(meta.organizationId);
  if (!organization) {
    sentryError(
      `Subscription event ${subscription.id} references deleted/missing organization ${meta.organizationId}`
    );
    throw new Error(
      `Organization ${meta.organizationId} not found (deleted or missing) for subscription ${subscription.id}`
    );
  }

  // Guard against duplicate seat subscriptions (Seat Purchase 6, H1).
  // When processing a subscription creation event, verify the org doesn't
  // already have a non-ended subscription for a different Stripe subscription.
  if (isCreation) {
    const existingActive = await db
      .select({
        id: organization_seats_purchases.id,
        subscription_stripe_id: organization_seats_purchases.subscription_stripe_id,
      })
      .from(organization_seats_purchases)
      .where(
        and(
          eq(organization_seats_purchases.organization_id, meta.organizationId),
          sql`${organization_seats_purchases.subscription_status} != 'ended'`,
          sql`${organization_seats_purchases.subscription_stripe_id} != ${subscription.id}`
        )
      )
      .limit(1);

    if (existingActive.length > 0) {
      // Local state may lag behind Stripe (e.g., the delete webhook for the old
      // subscription hasn't arrived yet). Check live Stripe state before rejecting.
      try {
        const existingSub = await stripeClient.subscriptions.retrieve(
          existingActive[0].subscription_stripe_id
        );
        if (!existingSub.ended_at) {
          // Genuinely still active in Stripe — reject the duplicate
          sentryError(
            `Duplicate seat subscription detected: org ${meta.organizationId} already has a non-ended subscription ${existingActive[0].subscription_stripe_id}. Rejecting subscription ${subscription.id}.`
          );
          throw new Error(
            `Organization ${meta.organizationId} already has a non-ended seat subscription`
          );
        }
        // Stripe says the old subscription has ended; local state is stale. Allow the new one.
        logExceptInTest(
          `Existing subscription ${existingActive[0].subscription_stripe_id} for org ${meta.organizationId} is ended in Stripe but stale locally; allowing new subscription ${subscription.id}`
        );
      } catch (error) {
        // If we can't verify with Stripe (e.g., network error), fail open to avoid
        // blocking valid subscriptions. The idempotency key still prevents true duplicates.
        if (error instanceof Error && error.message.includes('already has a non-ended')) {
          throw error; // Re-throw our own rejection
        }
        logExceptInTest(
          `Could not verify existing subscription ${existingActive[0].subscription_stripe_id} in Stripe; allowing new subscription ${subscription.id}`
        );
      }
    }
  }

  const lineItems = subscription.items.data ?? [];
  const firstLineItem = lineItems[0];
  if (!firstLineItem?.current_period_end) {
    throw new Error(`No period end found in invoice line items subscription ${subscription.id}`);
  }

  // Sum quantities from ALL line items in the subscription.
  // When a subscription has multiple prices for Kilo Teams (e.g., paid seats at one price
  // and free seats at another), Stripe stores them as separate line items.
  const seatCount = lineItems.reduce((total, item) => total + (item.quantity ?? 0), 0);

  // Calculate total amount from all line items (stripe amounts are in cents)
  const amountUsd = lineItems.reduce((total, item) => {
    const itemQuantity = item.quantity ?? 0;
    const unitAmount = item.price?.unit_amount ?? 0;
    return total + (unitAmount / 100) * itemQuantity;
  }, 0);

  // use the start & end date of the line item (which is in seconds, not millis)
  const startDate = new Date(firstLineItem.current_period_start * 1000);
  const endDate = new Date(firstLineItem.current_period_end * 1000);

  // Extract billing cycle from the paid seat item's recurring interval.
  // In mixed subscriptions, items[0] can be a free promotional item with a
  // different cadence, so we prefer the first item with unit_amount > 0.
  const paidLineItem = lineItems.find(item => (item.price?.unit_amount ?? 0) > 0);
  const billingCycleItem = paidLineItem ?? firstLineItem;
  const stripeInterval = billingCycleItem.price?.recurring?.interval;
  let billingCycleDb: 'monthly' | 'yearly';
  if (stripeInterval === 'month' || stripeInterval === 'year') {
    billingCycleDb = billingCycleToDb(billingCycleFromStripeInterval(stripeInterval));
  } else {
    billingCycleDb = 'monthly';
    sentryError(
      `Unrecognized recurring interval "${stripeInterval}" for subscription ${subscription.id}, defaulting to monthly`,
      { subscription_id: subscription.id, interval: stripeInterval }
    );
  }

  // Ensure metadata user is a member (Subscription Lifecycle 1-2).
  // If the user doesn't resolve, silently skip membership but continue processing.
  // If the user was previously removed (tombstone exists), do NOT re-add them.
  const metadataUser = await findUserById(meta.kiloUserId);
  if (metadataUser) {
    const [removal] = await db
      .select({ id: organization_membership_removals.id })
      .from(organization_membership_removals)
      .where(
        and(
          eq(organization_membership_removals.organization_id, meta.organizationId),
          eq(organization_membership_removals.kilo_user_id, meta.kiloUserId)
        )
      )
      .limit(1);

    if (removal) {
      logExceptInTest(
        `Skipping membership for removed user ${meta.kiloUserId} in org ${meta.organizationId} (Subscription Lifecycle 2)`
      );
    } else {
      await addUserToOrganization(meta.organizationId, meta.kiloUserId, 'owner');
    }
  } else {
    sentryError(
      `Metadata user ${meta.kiloUserId} not found for subscription ${subscription.id}, skipping membership`
    );
  }

  // handle subscription deletion
  const isSubscriptionEnded = subscription.ended_at;
  // Only update seat_count when subscription is fully active (payment succeeded).
  // For 'incomplete' or 'past_due' subscriptions, we record the purchase but don't
  // increase seat_count until payment succeeds (subscription becomes 'active').
  const isSubscriptionActive = subscription.status === 'active';

  await db.transaction(async tx => {
    // Insert with conflict handling - will do nothing if idempotency key already exists
    const { rowCount } = await tx
      .insert(organization_seats_purchases)
      .values({
        subscription_stripe_id: subscription.id,
        organization_id: meta.organizationId,
        seat_count: isSubscriptionEnded ? 0 : seatCount,
        amount_usd: isSubscriptionEnded ? 0 : amountUsd,
        expires_at: endDate.toISOString(),
        starts_at: startDate.toISOString(),
        // set undefined to autogen a key in the database if one is not supplied
        idempotency_key: idempotencyKey || undefined,
        subscription_status: isSubscriptionEnded ? 'ended' : subscription.status,
        billing_cycle: billingCycleDb,
      })
      .onConflictDoNothing({ target: [organization_seats_purchases.idempotency_key] });

    // if there were no rows changed, we hit our idempotency key
    if (rowCount === 0) {
      logExceptInTest(`Skipping update for ${idempotencyKey} - already exists`);
      return;
    }

    // Update organization plan from subscription metadata for ALL events (Org Plans 5)
    const plan = getPlanTypeFromSubscription(subscription);
    if (plan !== null) {
      await tx.update(organizations).set({ plan }).where(eq(organizations.id, meta.organizationId));
    }

    // if the subscription is ended, set seat count to 0 and do nothing else
    if (isSubscriptionEnded) {
      // update organization with new seat count only if it differs
      await tx
        .update(organizations)
        .set({ seat_count: 0 })
        .where(and(eq(organizations.id, meta.organizationId)));

      handleSubscriptionEndedNonEssential(meta);
      return;
    }

    // If subscription is not active (e.g., 'incomplete' due to failed payment),
    // don't update seat_count yet. The seat_count will be updated when the
    // subscription becomes active (via customer.subscription.updated webhook).
    if (!isSubscriptionActive) {
      logExceptInTest(
        `Subscription ${subscription.id} is ${subscription.status}, not updating seat_count yet`
      );
      return;
    }

    // get all purchases which have the max purchase date for this organization
    // this is to handle an instance where an older purchase or subscription event arrives AFTER a newer one
    // not common but there are tests covering this case
    const maxDateResult = await tx
      .select({ maxDate: organization_seats_purchases.starts_at })
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.organization_id, meta.organizationId))
      .orderBy(desc(organization_seats_purchases.starts_at))
      .limit(1);

    const maxDate = maxDateResult[0]?.maxDate;

    const purchaseRows = maxDate
      ? await tx
          .select()
          .from(organization_seats_purchases)
          .where(
            and(
              eq(organization_seats_purchases.organization_id, meta.organizationId),
              eq(organization_seats_purchases.starts_at, maxDate)
            )
          )
      : [];

    const maxSeatsForSubPeriod =
      purchaseRows.length > 0 ? Math.max(...purchaseRows.map(x => x.seat_count)) : 0;
    logExceptInTest(
      `setting seatCount to ${maxSeatsForSubPeriod} for organization ${meta.organizationId}`
    );

    // send subscription updated email event..we only want to log and email if this
    // is the first seat purchase in the time period. e.g. we don't send emails when they update seats mid-month
    if (!isCreation && purchaseRows.length === 1) {
      handleSubscriptionUpdatedNonEssential(meta, maxSeatsForSubPeriod);
    }

    await tx
      .update(organizations)
      .set({ seat_count: maxSeatsForSubPeriod })
      .where(eq(organizations.id, meta.organizationId));
  });

  if (isCreation) {
    handleSubscriptionCreatedNonEssential(meta);
  }
}

export async function handleSubscriptionEvent(
  subscription: Stripe.Subscription,
  idempotencyKey?: string,
  isCreation = false
) {
  try {
    await handleSubscriptionEventInternal(subscription, idempotencyKey, isCreation);
  } catch (error) {
    errorExceptInTest('Error handling subscription event:', error);
    captureException(error, {
      tags: { source: 'seat_subscription_event' },
      extra: {
        subscription: subscription.id,
        idempotencyKey,
      },
    });
    throw error;
  }
}

async function getOwnerEmailsForOrg(organizationId: string): Promise<string[]> {
  const members = await getOrganizationMembers(organizationId);
  // Only active (non-invitation) owners — exclude pending invited owners
  const activeOwners = members.filter(m => m.role === 'owner' && m.status === 'active');
  return activeOwners.map(o => o.email);
}

function handleSubscriptionUpdatedNonEssential(meta: SubscriptionMetadata, seats: number) {
  if (IS_IN_AUTOMATED_TEST) {
    return;
  }
  after(async () => {
    const hog = PostHogClient();
    const user = await findUserById(meta.kiloUserId);
    hog.capture({
      event: 'organization_subscription_renewed',
      distinctId: user?.google_user_email ?? meta.kiloUserId,
      properties: { organizationId: meta.organizationId, seatCount: seats },
    });

    const emails = await getOwnerEmailsForOrg(meta.organizationId);
    if (!emails) {
      sentryError(`No owners found for org ${meta.organizationId} to send subscription email`);
      return;
    }

    for (const email of emails) {
      try {
        await sendOrgRenewedEmail(email, {
          seatCount: seats,
          organizationId: meta.organizationId,
        });
      } catch (emailError) {
        captureException(emailError, {
          tags: { source: 'subscription_renewed_email' },
          extra: { email, organizationId: meta.organizationId },
        });
      }
    }
  });
}

function handleSubscriptionEndedNonEssential(meta: SubscriptionMetadata) {
  if (IS_IN_AUTOMATED_TEST) {
    return;
  }
  after(async () => {
    const user = await findUserById(meta.kiloUserId);
    const hog = PostHogClient();
    hog.capture({
      event: 'organization_subscription_cancelled',
      distinctId: user?.google_user_email || meta.kiloUserId,
      properties: { organizationId: meta.organizationId },
    });

    const emails = await getOwnerEmailsForOrg(meta.organizationId);
    if (!emails) {
      sentryError(`No owners found for org ${meta.organizationId} to send subscription email`);
      return;
    }
    for (const email of emails) {
      try {
        await sendOrgCancelledEmail(email, {
          organizationId: meta.organizationId,
        });
      } catch (emailError) {
        captureException(emailError, {
          tags: { source: 'subscription_cancelled_email' },
          extra: { email, organizationId: meta.organizationId },
        });
      }
    }
  });
}

function handleSubscriptionCreatedNonEssential(meta: SubscriptionMetadata) {
  if (IS_IN_AUTOMATED_TEST) {
    return;
  }
  after(async () => {
    const user = await findUserById(meta.kiloUserId);
    if (!user) {
      sentryError(`Could not find user ${meta.kiloUserId} to send subscription email`);
      return;
    }

    const hog = PostHogClient();
    hog.capture({
      event: 'organization_created',
      distinctId: user.google_user_email || meta.kiloUserId,
      properties: { organizationId: meta.organizationId, seatCount: meta.seats },
    });

    try {
      await sendOrgSubscriptionEmail(user.google_user_email, {
        seatCount: meta.seats,
        organizationId: meta.organizationId,
      });
    } catch (emailError) {
      captureException(emailError, {
        tags: { source: 'subscription_created_email' },
        extra: { email: user.google_user_email, organizationId: meta.organizationId },
      });
    }
  });
}

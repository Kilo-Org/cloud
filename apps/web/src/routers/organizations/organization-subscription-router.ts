import {
  retrieveSubscription,
  handleStopCancellation,
  handleUpdateSeatCount,
  getSubscriptionsForStripeCustomerId,
  getStripeSeatsCheckoutUrl,
  handleCancelSubscription,
  getPriceIdForPlanAndCycle,
  KNOWN_SEAT_PRICE_IDS,
  getPlanForPriceId,
} from '@/lib/stripe';
import {
  getMostRecentSeatPurchase,
  getMostRecentEndedSeatPurchase,
  getOrganizationSeatUsage,
} from '@/lib/organizations/organization-seats';
import { organization_seats_purchases } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { and, eq, desc, ne } from 'drizzle-orm';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationBillingProcedure,
  organizationBillingMutationProcedure,
  organizationMemberProcedure,
} from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type Stripe from 'stripe';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import { BillingCycleSchema } from '@/lib/organizations/organization-types';
import { successResult } from '@/lib/maybe-result';
import { client } from '@/lib/stripe-client';
import {
  billingHistoryResponseSchema,
  mapStripeInvoiceToBillingHistoryEntry,
} from '@/lib/subscriptions/subscription-center';

const SubscriptionRequestSchema = OrganizationIdInputSchema.extend({
  seats: z.number().int().min(1).max(100),
  cancelUrl: z.url(),
  plan: z.enum(['teams', 'enterprise']).optional(),
  billingCycle: BillingCycleSchema,
});

const UpdateSeatCountInputSchema = OrganizationIdInputSchema.extend({
  newSeatCount: z.number().int().min(1),
});

const OrganizationSubscriptionResponseSchema = z.object({
  subscription: z.custom<Stripe.Subscription>().nullable(),
  seatsUsed: z.number(),
  totalSeats: z.number(),
  paidSeatItemId: z.string().nullable(),
});

type OrganizationSubscriptionResponse = z.infer<typeof OrganizationSubscriptionResponseSchema>;

const SubscriptionActionResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});

const UpdateSeatCountResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  requiresAction: z.boolean().optional(),
  paymentIntentClientSecret: z.string().optional(),
});

const CursorInputSchema = OrganizationIdInputSchema.extend({
  cursor: z.string().optional(),
});

const ChangeBillingCycleInputSchema = OrganizationIdInputSchema.extend({
  targetCycle: BillingCycleSchema,
});

const BillingCycleChangeResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

const ResubscribeDefaultsResponseSchema = z.object({
  defaultSeatCount: z.number(),
  billingCycle: BillingCycleSchema,
});

export const organizationsSubscriptionRouter = createTRPCRouter({
  get: organizationBillingProcedure
    .input(OrganizationIdInputSchema)
    .output(OrganizationSubscriptionResponseSchema)
    .query(async ({ input }): Promise<OrganizationSubscriptionResponse> => {
      const { organizationId } = input;

      const usages = await getOrganizationSeatUsage(organizationId);

      // Get the most recent subscription from the organization_seats_purchases table
      const latestPurchase = await getMostRecentSeatPurchase(organizationId);

      if (!latestPurchase) {
        return {
          subscription: null,
          seatsUsed: usages.used,
          totalSeats: usages.total,
          paidSeatItemId: null,
        };
      }

      // Fetch the subscription information from Stripe — including ended
      // subscriptions so the overview card can show the resubscribe UI.
      let subscription: Stripe.Subscription | null = null;
      try {
        subscription = await retrieveSubscription(latestPurchase.subscription_stripe_id);
      } catch (error) {
        console.error(
          `Failed to retrieve Stripe subscription ${latestPurchase.subscription_stripe_id}:`,
          error
        );
        // Continue without Stripe data - we still have the purchase record
      }

      const paidSeatItemId =
        subscription?.items.data.find(item => KNOWN_SEAT_PRICE_IDS.has(item.price.id))?.id ?? null;

      return { subscription, seatsUsed: usages.used, totalSeats: usages.total, paidSeatItemId };
    }),

  getResubscribeDefaults: organizationMemberProcedure
    .input(OrganizationIdInputSchema)
    .output(ResubscribeDefaultsResponseSchema)
    .query(async ({ input }) => {
      const { organizationId } = input;

      const endedPurchase = await getMostRecentEndedSeatPurchase(organizationId);
      if (!endedPurchase) {
        return { defaultSeatCount: 1, billingCycle: 'annual' as const };
      }

      // The ended row has seat_count=0. Recover the paid quantity from the
      // last active purchase for the same Stripe subscription.
      const [lastActive] = await db
        .select({
          seat_count: organization_seats_purchases.seat_count,
          billing_cycle: organization_seats_purchases.billing_cycle,
        })
        .from(organization_seats_purchases)
        .where(
          and(
            eq(
              organization_seats_purchases.subscription_stripe_id,
              endedPurchase.subscription_stripe_id
            ),
            ne(organization_seats_purchases.subscription_status, 'ended')
          )
        )
        .orderBy(desc(organization_seats_purchases.created_at))
        .limit(1);

      // Try to derive paid-only seat count from the ended Stripe subscription.
      // seat_count in the DB includes all line items (paid + free); for resubscribe
      // we only want paid seats to avoid overcharging.
      let defaultSeatCount = Math.max(1, lastActive?.seat_count ?? 1);
      try {
        const sub = await retrieveSubscription(endedPurchase.subscription_stripe_id);
        const paidOnly = sub.items.data
          .filter(item => KNOWN_SEAT_PRICE_IDS.has(item.price.id))
          .reduce((total, item) => total + (item.quantity ?? 0), 0);
        if (paidOnly > 0) {
          defaultSeatCount = paidOnly;
        }
      } catch {
        // Stripe retrieval failed; fall back to total seat_count from DB
      }
      const dbCycle = lastActive?.billing_cycle ?? endedPurchase.billing_cycle;
      const billingCycle = dbCycle === 'yearly' ? ('annual' as const) : ('monthly' as const);

      return { defaultSeatCount, billingCycle };
    }),

  getByStripeSessionId: baseProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .query(async ({ input }) => {
      const { sessionId } = input;

      const session = await client.checkout.sessions.retrieve(sessionId);
      const paymentStatus = session.payment_status;
      if (paymentStatus !== 'paid') {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: `Session not found or payment not completed for id ${sessionId}`,
        });
      }
      if (session.subscription && typeof session.subscription === 'string') {
        // make sure subscription exists as well
        const res = await retrieveSubscription(session.subscription);
        if (!res) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: `Subscription not found for session ${sessionId}`,
          });
        }
      }
      return { status: paymentStatus };
    }),

  getSubscriptionStripeUrl: organizationBillingProcedure
    .input(SubscriptionRequestSchema)
    .mutation(async ({ input, ctx }) => {
      const { user } = ctx;
      const { organizationId, seats, plan } = input;
      const org = await getOrganizationById(organizationId);
      if (!org) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }
      const customerId = await getOrCreateStripeCustomerIdForOrganization(org.id);
      const subscriptions = await getSubscriptionsForStripeCustomerId(customerId);

      if (subscriptions.find(sub => sub.ended_at == null)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Organization has active subscription(s)',
        });
      }

      const result = await getStripeSeatsCheckoutUrl({
        kiloUserId: user.id,
        stripeCustomerId: customerId,
        quantity: seats,
        organizationId,
        cancelUrl: input.cancelUrl,
        plan: plan ?? org.plan,
        billingCycle: input.billingCycle,
      });
      return { url: result };
    }),

  cancel: organizationBillingMutationProcedure
    .input(OrganizationIdInputSchema)
    .output(SubscriptionActionResponseSchema.extend({ message: z.string() }))
    .mutation(async ({ input }) => {
      const { organizationId } = input;

      // Get the most recent subscription from the organization_seats_purchases table
      const latestPurchase = await getMostRecentSeatPurchase(organizationId);

      if (!latestPurchase) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No subscription found for this organization',
        });
      }

      const purchase = latestPurchase;
      await handleCancelSubscription(purchase.subscription_stripe_id);

      return successResult({
        message: 'Your subscription will be canceled at the end of the current billing period.',
      });
    }),

  stopCancellation: organizationBillingMutationProcedure
    .input(OrganizationIdInputSchema)
    .output(SubscriptionActionResponseSchema)
    .mutation(async ({ input }) => {
      const { organizationId } = input;

      // Get the most recent subscription from the organization_seats_purchases table
      const latestPurchase = await getMostRecentSeatPurchase(organizationId);

      if (!latestPurchase) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No subscription found for this organization',
        });
      }

      const purchase = latestPurchase;
      const result = await handleStopCancellation(purchase.subscription_stripe_id);
      return result;
    }),

  updateSeatCount: organizationBillingMutationProcedure
    .input(UpdateSeatCountInputSchema)
    .output(UpdateSeatCountResponseSchema)
    .mutation(async ({ input }) => {
      const { organizationId, newSeatCount } = input;

      const { used, total } = await getOrganizationSeatUsage(organizationId);

      if (used > newSeatCount) {
        // If we're downgrading seats, we need to ensure the organization is not using more seats than they're allowed
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot downgrade seats: organization is using ${used} seats, but only ${newSeatCount} were requested.`,
        });
      }

      // Get the most recent subscription from the organization_seats_purchases table
      const latestPurchase = await getMostRecentSeatPurchase(organizationId);

      if (!latestPurchase) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No subscription found for this organization',
        });
      }

      const purchase = latestPurchase;
      return await handleUpdateSeatCount(purchase.subscription_stripe_id, newSeatCount, total);
    }),

  getCustomerPortalUrl: organizationBillingProcedure
    .input(
      z.object({
        organizationId: z.uuid(),
        returnUrl: z.url().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { organizationId, returnUrl } = input;

      const org = await getOrganizationById(organizationId);
      if (!org) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      const customerId = await getOrCreateStripeCustomerIdForOrganization(org.id);
      const subscriptions = await getSubscriptionsForStripeCustomerId(customerId);

      if (!subscriptions.length || subscriptions.every(sub => sub.ended_at != null)) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No active subscription found for this organization',
        });
      }

      const session = await client.billingPortal.sessions.create({
        customer: customerId,
        return_url: returnUrl,
      });

      return { url: session.url };
    }),

  getBillingHistory: organizationBillingProcedure
    .input(CursorInputSchema)
    .output(billingHistoryResponseSchema)
    .query(async ({ input }) => {
      const latestPurchase = await getMostRecentSeatPurchase(input.organizationId);
      if (!latestPurchase) {
        return { entries: [], hasMore: false, cursor: null };
      }

      const customerId = await getOrCreateStripeCustomerIdForOrganization(input.organizationId);

      const invoices = await client.invoices.list({
        customer: customerId,
        subscription: latestPurchase.subscription_stripe_id,
        limit: 25,
        ...(input.cursor ? { starting_after: input.cursor } : {}),
      });

      return {
        entries: invoices.data.map(mapStripeInvoiceToBillingHistoryEntry),
        hasMore: invoices.has_more,
        cursor: invoices.has_more ? (invoices.data.at(-1)?.id ?? null) : null,
      };
    }),

  changeBillingCycle: organizationBillingMutationProcedure
    .input(ChangeBillingCycleInputSchema)
    .output(BillingCycleChangeResponseSchema)
    .mutation(async ({ input }) => {
      const { organizationId, targetCycle } = input;

      const latestPurchase = await getMostRecentSeatPurchase(organizationId);
      if (!latestPurchase) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No subscription found for this organization',
        });
      }

      const subscription = await retrieveSubscription(latestPurchase.subscription_stripe_id);

      // Find the paid seat item by matching against known seat price IDs,
      // not blindly using items[0] which could be a free-seat price.
      const paidSeatItem = subscription.items.data.find(item =>
        KNOWN_SEAT_PRICE_IDS.has(item.price.id)
      );
      if (!paidSeatItem) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Subscription has no recognized paid seat item',
        });
      }

      const currentInterval = paidSeatItem.price.recurring?.interval;
      const currentCycle = currentInterval === 'year' ? 'annual' : 'monthly';

      if (currentCycle === targetCycle) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Subscription is already on ${targetCycle} billing`,
        });
      }

      // Check if there's an active schedule (pending cycle change)
      const scheduleRef = subscription.schedule;
      if (scheduleRef) {
        const schedule =
          typeof scheduleRef === 'string'
            ? await client.subscriptionSchedules.retrieve(scheduleRef)
            : scheduleRef;
        if (schedule.status === 'active' || schedule.status === 'not_started') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'A billing cycle change is already scheduled. Cancel the existing change before scheduling a new one.',
          });
        }
      }

      // Derive the plan tier from the live Stripe price, not from org.plan,
      // because admins can update the org plan independently.
      const currentPriceId = paidSeatItem.price.id;
      const stripePlan = getPlanForPriceId(currentPriceId);
      if (!stripePlan) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Cannot determine plan tier from subscription price',
        });
      }
      const newPriceId = getPriceIdForPlanAndCycle(stripePlan, targetCycle);

      // Preserve ALL subscription items (handles mixed paid/free seat prices).
      // Only swap the price on the paid seat item; leave other items untouched.
      const currentItems = subscription.items.data.map(item => ({
        price: item.price.id,
        quantity: item.quantity ?? 1,
      }));
      const phase2Items = subscription.items.data.map(item => ({
        price: item.price.id === currentPriceId ? newPriceId : item.price.id,
        quantity: item.quantity ?? 1,
      }));

      // Preserve subscription-level discounts (promotion codes, coupons).
      // Stripe schedule phases only inherit customer-level discounts by default.
      const discountIds = (subscription.discounts ?? [])
        .map(d => (typeof d === 'string' ? d : d.id))
        .filter((id): id is string => id != null);
      const phaseDiscounts =
        discountIds.length > 0 ? discountIds.map(id => ({ discount: id })) : undefined;

      let schedule: Stripe.SubscriptionSchedule;
      try {
        schedule = await client.subscriptionSchedules.create({
          from_subscription: subscription.id,
        });
      } catch (error) {
        // Concurrent requests may both pass the existing-schedule check above
        // but only one can create a schedule. Catch the Stripe rejection for the
        // second and return a clean client error instead of a 500.
        if (
          error instanceof Error &&
          'type' in error &&
          (error as { code?: string }).code === 'resource_already_exists'
        ) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'A billing cycle change is already scheduled. Cancel the existing change before scheduling a new one.',
          });
        }
        throw error;
      }

      const firstPhase = schedule.phases[0];
      if (!firstPhase) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Schedule has no phases',
        });
      }

      try {
        await client.subscriptionSchedules.update(schedule.id, {
          metadata: { origin: 'billing-cycle-change' },
          end_behavior: 'release',
          phases: [
            {
              items: currentItems,
              start_date: firstPhase.start_date,
              end_date: firstPhase.end_date,
              proration_behavior: 'none',
              discounts: phaseDiscounts,
            },
            {
              items: phase2Items,
              proration_behavior: 'none',
              billing_cycle_anchor: 'phase_start',
              duration: {
                interval: targetCycle === 'annual' ? 'year' : 'month',
                interval_count: 1,
              },
              discounts: phaseDiscounts,
            },
          ],
        });
      } catch (error) {
        // Release the orphaned schedule so the org isn't permanently stuck
        try {
          await client.subscriptionSchedules.release(schedule.id);
        } catch (releaseError) {
          console.error('Failed to release orphaned subscription schedule:', releaseError);
        }
        throw error;
      }

      return successResult({
        message: `Billing cycle will change to ${targetCycle} at the end of the current period.`,
      });
    }),

  cancelBillingCycleChange: organizationBillingMutationProcedure
    .input(OrganizationIdInputSchema)
    .output(BillingCycleChangeResponseSchema)
    .mutation(async ({ input }) => {
      const { organizationId } = input;

      const latestPurchase = await getMostRecentSeatPurchase(organizationId);
      if (!latestPurchase) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No subscription found for this organization',
        });
      }

      const subscription = await retrieveSubscription(latestPurchase.subscription_stripe_id);

      const cancelScheduleRef = subscription.schedule;
      if (!cancelScheduleRef) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No pending billing cycle change to cancel',
        });
      }

      const resolvedSchedule =
        typeof cancelScheduleRef === 'string'
          ? await client.subscriptionSchedules.retrieve(cancelScheduleRef)
          : cancelScheduleRef;

      if (resolvedSchedule.status !== 'active' && resolvedSchedule.status !== 'not_started') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No pending billing cycle change to cancel',
        });
      }

      // Verify the schedule was created by the billing-cycle-change flow
      // to avoid releasing unrelated schedules.
      if (
        resolvedSchedule.metadata?.origin !== 'billing-cycle-change' ||
        resolvedSchedule.phases.length !== 2
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'No pending billing cycle change to cancel',
        });
      }

      await client.subscriptionSchedules.release(resolvedSchedule.id);

      return successResult({
        message: 'Scheduled billing cycle change has been canceled.',
      });
    }),
});

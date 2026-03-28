import {
  retrieveSubscription,
  handleStopCancellation,
  handleUpdateSeatCount,
  getSubscriptionsForStripeCustomerId,
  getStripeSeatsCheckoutUrl,
  handleCancelSubscription,
  getPriceIdForPlanAndCycle,
} from '@/lib/stripe';
import {
  getMostRecentSeatPurchase,
  getOrganizationSeatUsage,
} from '@/lib/organizations/organization-seats';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  organizationOwnerProcedure,
  organizationMemberProcedure,
} from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type Stripe from 'stripe';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import { BillingCycleSchema } from '@/lib/organizations/organization-types';
import { successResult } from '@/lib/maybe-result';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import { client } from '@/lib/stripe-client';

const SubscriptionRequestSchema = OrganizationIdInputSchema.extend({
  seats: z.number().int().min(1).max(100),
  cancelUrl: z.url(),
  plan: z.enum(['teams', 'enterprise']).optional(),
  billingCycle: BillingCycleSchema.optional().default('annual'),
});

const UpdateSeatCountInputSchema = OrganizationIdInputSchema.extend({
  newSeatCount: z.number().int().min(1),
});

const OrganizationSubscriptionResponseSchema = z.object({
  subscription: z.custom<Stripe.Subscription>().nullable(),
  seatsUsed: z.number(),
  totalSeats: z.number(),
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

const ChangeBillingCycleInputSchema = OrganizationIdInputSchema.extend({
  targetCycle: BillingCycleSchema,
});

const BillingCycleChangeResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
});

export const organizationsSubscriptionRouter = createTRPCRouter({
  get: organizationMemberProcedure
    .input(OrganizationIdInputSchema)
    .output(OrganizationSubscriptionResponseSchema)
    .query(async ({ input }): Promise<OrganizationSubscriptionResponse> => {
      const { organizationId } = input;

      const usages = await getOrganizationSeatUsage(organizationId);

      // Get the most recent subscription from the organization_seats_purchases table
      const latestPurchase = await getMostRecentSeatPurchase(organizationId);

      if (!latestPurchase || latestPurchase.subscription_status === 'ended') {
        return {
          subscription: null,
          seatsUsed: usages.used,
          totalSeats: usages.total,
        };
      }

      // Fetch the subscription information from Stripe
      let subscription = null;
      try {
        subscription = await retrieveSubscription(latestPurchase.subscription_stripe_id);
      } catch (error) {
        console.error(
          `Failed to retrieve Stripe subscription ${latestPurchase.subscription_stripe_id}:`,
          error
        );
        // Continue without Stripe data - we still have the purchase record
      }

      return { subscription, seatsUsed: usages.used, totalSeats: usages.total };
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

  getSubscriptionStripeUrl: organizationOwnerProcedure
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

  cancel: organizationOwnerProcedure
    .input(OrganizationIdInputSchema)
    .output(SubscriptionActionResponseSchema.extend({ message: z.string() }))
    .mutation(async ({ input }) => {
      const { organizationId } = input;

      await requireActiveSubscriptionOrTrial(organizationId);

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

  stopCancellation: organizationOwnerProcedure
    .input(OrganizationIdInputSchema)
    .output(SubscriptionActionResponseSchema)
    .mutation(async ({ input }) => {
      const { organizationId } = input;

      await requireActiveSubscriptionOrTrial(organizationId);

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

  updateSeatCount: organizationOwnerProcedure
    .input(UpdateSeatCountInputSchema)
    .output(UpdateSeatCountResponseSchema)
    .mutation(async ({ input }) => {
      const { organizationId, newSeatCount } = input;

      await requireActiveSubscriptionOrTrial(organizationId);
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

  getCustomerPortalUrl: organizationOwnerProcedure
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

  changeBillingCycle: organizationOwnerProcedure
    .input(ChangeBillingCycleInputSchema)
    .output(BillingCycleChangeResponseSchema)
    .mutation(async ({ input }) => {
      const { organizationId, targetCycle } = input;

      await requireActiveSubscriptionOrTrial(organizationId);

      const latestPurchase = await getMostRecentSeatPurchase(organizationId);
      if (!latestPurchase) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No subscription found for this organization',
        });
      }

      const subscription = await retrieveSubscription(latestPurchase.subscription_stripe_id);

      const firstItem = subscription.items.data[0];
      if (!firstItem) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Subscription has no items',
        });
      }

      const currentInterval = firstItem.price.recurring?.interval;
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

      const org = await getOrganizationById(organizationId);
      if (!org) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      const currentPriceId = firstItem.price.id;
      const newPriceId = getPriceIdForPlanAndCycle(org.plan, targetCycle);

      // Preserve ALL subscription items (handles mixed paid/free seat prices)
      const currentItems = subscription.items.data.map(item => ({
        price: item.price.id,
        quantity: item.quantity ?? 1,
      }));
      const phase2Items = subscription.items.data.map(item => ({
        price: item.price.id === currentPriceId ? newPriceId : item.price.id,
        quantity: item.quantity ?? 1,
      }));

      const schedule = await client.subscriptionSchedules.create({
        from_subscription: subscription.id,
      });

      const firstPhase = schedule.phases[0];
      if (!firstPhase) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Schedule has no phases',
        });
      }

      try {
        await client.subscriptionSchedules.update(schedule.id, {
          end_behavior: 'release',
          phases: [
            {
              items: currentItems,
              start_date: firstPhase.start_date,
              end_date: firstPhase.end_date,
              proration_behavior: 'none',
            },
            {
              items: phase2Items,
              proration_behavior: 'none',
              billing_cycle_anchor: 'phase_start',
              duration: {
                interval: targetCycle === 'annual' ? 'year' : 'month',
                interval_count: 1,
              },
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

  cancelBillingCycleChange: organizationOwnerProcedure
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

      await client.subscriptionSchedules.release(resolvedSchedule.id);

      return successResult({
        message: 'Scheduled billing cycle change has been canceled.',
      });
    }),
});

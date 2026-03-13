import {
  retrieveSubscription,
  handleStopCancellation,
  handleUpdateSeatCount,
  getSubscriptionsForStripeCustomerId,
  getStripeSeatsCheckoutUrl,
  handleCancelSubscription,
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
  ensureOrganizationAccess,
  organizationMemberProcedure,
} from '@/routers/organizations/utils';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import type Stripe from 'stripe';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import { successResult } from '@/lib/maybe-result';
import { requireActiveSubscriptionOrTrial } from '@/lib/organizations/trial-middleware';
import { client } from '@/lib/stripe-client';

const SubscriptionRequestSchema = OrganizationIdInputSchema.extend({
  seats: z.number().int().min(1).max(100),
  cancelUrl: z.url(),
  plan: z.enum(['teams', 'enterprise']).optional(),
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

  getSubscriptionStripeUrl: baseProcedure
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

      // if any subscriptions are not ended, throw bad request error
      if (subscriptions.find(sub => sub.ended_at == null)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Organization has active subscription(s)',
        });
      }

      // Org creators always get an owner membership row at creation time, so there is
      // no "mid-setup" window where the caller lacks a role. Enforce owner/billing_manager
      // unconditionally, matching every other billing mutation in this router.
      await ensureOrganizationAccess(ctx, organizationId, ['owner', 'billing_manager']);

      const result = await getStripeSeatsCheckoutUrl({
        kiloUserId: user.id,
        stripeCustomerId: customerId,
        quantity: seats,
        organizationId,
        cancelUrl: input.cancelUrl,
        plan: plan ?? org.plan,
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
});

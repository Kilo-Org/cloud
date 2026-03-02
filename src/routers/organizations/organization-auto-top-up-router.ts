import { createTRPCRouter } from '@/lib/trpc/init';
import {
  organizationOwnerProcedure,
  OrganizationIdInputSchema,
} from '@/routers/organizations/utils';
import { db } from '@/lib/drizzle';
import { auto_top_up_configs, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { successResult } from '@/lib/maybe-result';
import {
  OrgAutoTopUpAmountCentsSchema,
  DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS,
} from '@/lib/autoTopUpConstants';
import type { OrgAutoTopUpAmountCents } from '@/lib/autoTopUpConstants';
import { createOrgAutoTopUpSetupCheckoutSession } from '@/lib/organizations/organization-auto-top-up';
import { getOrganizationById } from '@/lib/organizations/organizations';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import { retrievePaymentMethodInfo } from '@/lib/stripePaymentMethodInfo';

export const organizationAutoTopUpRouter = createTRPCRouter({
  getConfig: organizationOwnerProcedure.query(async ({ input }) => {
    const { organizationId } = input;

    const config = await db.query.auto_top_up_configs.findFirst({
      where: eq(auto_top_up_configs.owned_by_organization_id, organizationId),
    });

    const org = await getOrganizationById(organizationId);
    if (!org) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
    }

    const paymentMethod = await retrievePaymentMethodInfo(config?.stripe_payment_method_id);
    const amountCents =
      (config?.amount_cents as OrgAutoTopUpAmountCents) ?? DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS;
    return { enabled: org.auto_top_up_enabled, amountCents, paymentMethod };
  }),

  toggle: organizationOwnerProcedure
    .input(
      OrganizationIdInputSchema.extend({
        currentEnabled: z.boolean(),
        amountCents: OrgAutoTopUpAmountCentsSchema.optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { organizationId, currentEnabled, amountCents } = input;

      if (currentEnabled) {
        // Disabling auto-top-up
        await db
          .update(organizations)
          .set({ auto_top_up_enabled: false })
          .where(eq(organizations.id, organizationId));
        return { enabled: false } as const;
      } else {
        // Enabling auto-top-up
        const config = await db.query.auto_top_up_configs.findFirst({
          where: eq(auto_top_up_configs.owned_by_organization_id, organizationId),
        });

        if (config?.stripe_payment_method_id) {
          // Has existing payment method - enable directly
          await db
            .update(organizations)
            .set({ auto_top_up_enabled: true })
            .where(eq(organizations.id, organizationId));
          await db
            .update(auto_top_up_configs)
            .set({
              disabled_reason: null,
              attempt_started_at: null,
              ...(amountCents != null ? { amount_cents: amountCents } : {}),
            })
            .where(eq(auto_top_up_configs.owned_by_organization_id, organizationId));
          return { enabled: true } as const;
        } else {
          // No payment method - redirect to Stripe checkout
          const stripeCustomerId = await getOrCreateStripeCustomerIdForOrganization(organizationId);
          const selectedAmount = amountCents ?? DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS;

          const redirectUrl = await createOrgAutoTopUpSetupCheckoutSession(
            ctx.user.id,
            organizationId,
            stripeCustomerId,
            selectedAmount
          );

          if (!redirectUrl) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to create checkout session',
            });
          }

          return { enabled: false, redirectUrl } as const;
        }
      }
    }),

  changePaymentMethod: organizationOwnerProcedure
    .input(
      OrganizationIdInputSchema.extend({
        amountCents: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { organizationId, amountCents } = input;
      const selectedAmount = amountCents ?? DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS;

      const stripeCustomerId = await getOrCreateStripeCustomerIdForOrganization(organizationId);

      const redirectUrl = await createOrgAutoTopUpSetupCheckoutSession(
        ctx.user.id,
        organizationId,
        stripeCustomerId,
        selectedAmount
      );

      if (!redirectUrl) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create checkout session',
        });
      }

      return { redirectUrl };
    }),

  updateAmount: organizationOwnerProcedure
    .input(
      OrganizationIdInputSchema.extend({
        amountCents: OrgAutoTopUpAmountCentsSchema,
      })
    )
    .mutation(async ({ input }) => {
      const { organizationId, amountCents } = input;

      await db
        .update(auto_top_up_configs)
        .set({ amount_cents: amountCents })
        .where(eq(auto_top_up_configs.owned_by_organization_id, organizationId));

      return successResult();
    }),

  removePaymentMethod: organizationOwnerProcedure.mutation(async ({ input }) => {
    const { organizationId } = input;

    await db
      .delete(auto_top_up_configs)
      .where(eq(auto_top_up_configs.owned_by_organization_id, organizationId));

    await db
      .update(organizations)
      .set({ auto_top_up_enabled: false })
      .where(eq(organizations.id, organizationId));

    return successResult();
  }),
});

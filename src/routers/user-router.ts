import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { getUserAuthProviders, unlinkAuthProviderFromUser } from '@/lib/user';
import { createAccountLinkingSession } from '@/lib/account-linking-session';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { assertNoTrpcError, successResult } from '@/lib/maybe-result';
import { db } from '@/lib/drizzle';
import {
  kilocode_users,
  microdollar_usage,
  credit_transactions,
  auto_top_up_configs,
} from '@/db/schema';
import { eq, and, isNull, sql } from 'drizzle-orm';
import crypto from 'crypto';
import { AuthProviderIdSchema } from '@/lib/auth/provider-metadata';
import { AUTOCOMPLETE_MODEL } from '@/lib/constants';
import { ensureOrganizationAccess } from '@/routers/organizations/utils';
import { createAutoTopUpSetupCheckoutSession } from '@/lib/stripe';
import { retrievePaymentMethodInfo } from '@/lib/stripePaymentMethodInfo';
import type { AutoTopUpAmountCents } from '@/lib/autoTopUpConstants';
import {
  AutoTopUpAmountCentsSchema,
  DEFAULT_AUTO_TOP_UP_AMOUNT_CENTS,
} from '@/lib/autoTopUpConstants';
import { getCreditBlocks } from '@/lib/getCreditBlocks';

const ViewTypeSchema = z.union([z.literal('personal'), z.literal('all'), z.uuid()]);

const AutocompleteMetricsInputSchema = z.object({
  viewType: ViewTypeSchema.default('personal'),
});

const AutocompleteMetricsOutputSchema = z.object({
  cost: z.number(),
  requests: z.number(),
  tokens: z.number(),
});

const LinkAuthProviderInputSchema = z.object({
  provider: AuthProviderIdSchema,
});

const CreditBlockSchema = z.object({
  id: z.string(),
  effective_date: z.string(),
  expiry_date: z.string().nullable(),
  balance_mUsd: z.number(),
  amount_mUsd: z.number(),
  is_free: z.boolean(),
});

const GetCreditBlocksInputSchema = z.object({});

const GetCreditBlocksOutputSchema = z.object({
  creditBlocks: z.array(CreditBlockSchema),
  totalBalance_mUsd: z.number(),
  isFirstPurchase: z.boolean(),
  autoTopUpEnabled: z.boolean(),
});

export const userRouter = createTRPCRouter({
  // Account linking routes
  getAuthProviders: baseProcedure.query(async ({ ctx }) => {
    const providers = await getUserAuthProviders(ctx.user.id);

    return successResult({
      providers: providers.map(provider => ({
        provider: provider.provider,
        email: provider.email,
        avatar_url: provider.avatar_url,
        hosted_domain: provider.hosted_domain,
        created_at: provider.created_at,
      })),
    });
  }),

  linkAuthProvider: baseProcedure
    .input(LinkAuthProviderInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        // Create a secure linking session
        await createAccountLinkingSession(ctx.user.id, input.provider);

        return successResult();
      } catch (error) {
        console.error('Error initiating account link:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to initiate account linking',
        });
      }
    }),

  unlinkAuthProvider: baseProcedure
    .input(LinkAuthProviderInputSchema)
    .mutation(async ({ ctx, input }) => {
      return assertNoTrpcError(await unlinkAuthProviderFromUser(ctx.user.id, input.provider));
    }),

  resetAPIKey: baseProcedure.mutation(async ({ ctx }) => {
    await db
      .update(kilocode_users)
      .set({ api_token_pepper: crypto.randomUUID() })
      .where(eq(kilocode_users.id, ctx.user.id));

    return successResult();
  }),

  getCreditBlocks: baseProcedure
    .input(GetCreditBlocksInputSchema)
    .output(GetCreditBlocksOutputSchema)
    .query(async ({ ctx }) => {
      const now = new Date();

      const transactions = await db.query.credit_transactions.findMany({
        where: and(
          eq(credit_transactions.kilo_user_id, ctx.user.id),
          isNull(credit_transactions.organization_id)
        ),
      });

      return {
        ...getCreditBlocks(transactions, now, ctx.user),
        autoTopUpEnabled: ctx.user.auto_top_up_enabled,
      };
    }),

  getAutocompleteMetrics: baseProcedure
    .input(AutocompleteMetricsInputSchema)
    .output(AutocompleteMetricsOutputSchema)
    .query(async ({ ctx, input }) => {
      const { viewType } = input;
      const userId = ctx.user.id;

      if (viewType !== 'personal' && viewType !== 'all') {
        await ensureOrganizationAccess(ctx, viewType);
      }

      // Build where clause based on view type, filtering for autocomplete model
      let whereClause;
      if (viewType === 'personal') {
        whereClause = and(
          eq(microdollar_usage.kilo_user_id, userId),
          isNull(microdollar_usage.organization_id),
          eq(microdollar_usage.model, AUTOCOMPLETE_MODEL)
        );
      } else if (viewType === 'all') {
        whereClause = and(
          eq(microdollar_usage.kilo_user_id, userId),
          eq(microdollar_usage.model, AUTOCOMPLETE_MODEL)
        );
      } else {
        whereClause = and(
          eq(microdollar_usage.kilo_user_id, userId),
          eq(microdollar_usage.organization_id, viewType),
          eq(microdollar_usage.model, AUTOCOMPLETE_MODEL)
        );
      }

      // Query aggregated autocomplete usage
      const result = await db
        .select({
          total_cost: sql<number>`COALESCE(SUM(${microdollar_usage.cost}), 0)::float`,
          request_count: sql<number>`COUNT(*)::float`,
          total_tokens: sql<number>`COALESCE(SUM(${microdollar_usage.input_tokens}) + SUM(${microdollar_usage.output_tokens}), 0)::float`,
        })
        .from(microdollar_usage)
        .where(whereClause);

      const metrics = result[0] || { total_cost: 0, request_count: 0, total_tokens: 0 };

      return {
        cost: metrics.total_cost,
        requests: metrics.request_count,
        tokens: metrics.total_tokens,
      };
    }),

  toggleAutoTopUp: baseProcedure
    .input(
      z.object({ currentEnabled: z.boolean(), amountCents: AutoTopUpAmountCentsSchema.optional() })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.currentEnabled) {
        // Disabling auto-top-up
        await db
          .update(kilocode_users)
          .set({ auto_top_up_enabled: false })
          .where(eq(kilocode_users.id, ctx.user.id));
        return { enabled: false } as const;
      } else {
        // Enabling auto-top-up
        const config = await db.query.auto_top_up_configs.findFirst({
          where: eq(auto_top_up_configs.owned_by_user_id, ctx.user.id),
        });

        if (config?.stripe_payment_method_id) {
          await db
            .update(kilocode_users)
            .set({ auto_top_up_enabled: true })
            .where(eq(kilocode_users.id, ctx.user.id));
          await db
            .update(auto_top_up_configs)
            .set({
              disabled_reason: null,
              attempt_started_at: null,
              ...(input.amountCents != null ? { amount_cents: input.amountCents } : {}),
            })
            .where(eq(auto_top_up_configs.owned_by_user_id, ctx.user.id));
          return { enabled: true } as const;
        } else {
          const amountCents = input.amountCents ?? 5000;
          const redirectUrl = await createAutoTopUpSetupCheckoutSession(
            ctx.user.id,
            ctx.user.stripe_customer_id,
            amountCents
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

  changeAutoTopUpPaymentMethod: baseProcedure
    .input(z.object({ amountCents: z.number().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const amountCents = input?.amountCents ?? 5000;
      const redirectUrl = await createAutoTopUpSetupCheckoutSession(
        ctx.user.id,
        ctx.user.stripe_customer_id,
        amountCents
      );

      if (!redirectUrl) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create checkout session',
        });
      }

      return { redirectUrl };
    }),

  getAutoTopUpPaymentMethod: baseProcedure.query(async ({ ctx }) => {
    const config = await db.query.auto_top_up_configs.findFirst({
      where: eq(auto_top_up_configs.owned_by_user_id, ctx.user.id),
    });
    const paymentMethod = await retrievePaymentMethodInfo(config?.stripe_payment_method_id);
    const amountCents =
      (config?.amount_cents as AutoTopUpAmountCents) ?? DEFAULT_AUTO_TOP_UP_AMOUNT_CENTS;
    return { enabled: ctx.user.auto_top_up_enabled, amountCents, paymentMethod };
  }),

  updateAutoTopUpAmount: baseProcedure
    .input(z.object({ amountCents: AutoTopUpAmountCentsSchema }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(auto_top_up_configs)
        .set({ amount_cents: input.amountCents })
        .where(eq(auto_top_up_configs.owned_by_user_id, ctx.user.id));
      return successResult();
    }),

  removeAutoTopUpPaymentMethod: baseProcedure.mutation(async ({ ctx }) => {
    await db
      .delete(auto_top_up_configs)
      .where(eq(auto_top_up_configs.owned_by_user_id, ctx.user.id));
    await db
      .update(kilocode_users)
      .set({ auto_top_up_enabled: false })
      .where(eq(kilocode_users.id, ctx.user.id));
    return successResult();
  }),

  updateProfile: baseProcedure
    .input(
      z.object({
        linkedin_url: z
          .string()
          .url()
          .refine(val => /^https?:\/\//i.test(val), { message: 'URL must use http or https' })
          .nullable()
          .optional(),
        github_url: z
          .string()
          .url()
          .refine(val => /^https?:\/\//i.test(val), { message: 'URL must use http or https' })
          .nullable()
          .optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const updates: Partial<typeof kilocode_users.$inferInsert> = {};
      if (input.linkedin_url !== undefined) updates.linkedin_url = input.linkedin_url;
      if (input.github_url !== undefined) updates.github_url = input.github_url;

      if (Object.keys(updates).length === 0) {
        return successResult();
      }

      await db.update(kilocode_users).set(updates).where(eq(kilocode_users.id, ctx.user.id));

      return successResult();
    }),
});

import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { getUserAuthProviders, unlinkAuthProviderFromUser } from '@/lib/user';
import { createAccountLinkingSession } from '@/lib/account-linking-session';
import { TRPCError } from '@trpc/server';
import { captureException } from '@sentry/nextjs';
import * as z from 'zod';
import { assertNoTrpcError, successResult } from '@/lib/maybe-result';
import { db, readDb } from '@/lib/drizzle';
import { timedUsageQuery } from '@/lib/usage-query';
import {
  kilocode_users,
  microdollar_usage,
  credit_transactions,
  auto_top_up_configs,
  user_auth_provider,
} from '@kilocode/db/schema';
import { eq, and, isNull, sql, gte } from 'drizzle-orm';
import crypto from 'crypto';
import { checkDiscordGuildMembership } from '@/lib/integrations/discord-guild-membership';
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
import { getBalanceForUser } from '@/lib/user.balance';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';

const ViewTypeSchema = z.union([z.literal('personal'), z.literal('all'), z.uuid()]);

export const PeriodSchema = z.enum(['week', 'month', 'year', 'all']);
export type Period = z.infer<typeof PeriodSchema>;

function daysAgo(days: number): string {
  const now = new Date();
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function getDateThreshold(period: Period): string | null {
  switch (period) {
    case 'week':
      return daysAgo(7);
    case 'month':
      return daysAgo(30);
    case 'year':
      return daysAgo(365);
    case 'all':
      return null;
  }
}

const AutocompleteMetricsInputSchema = z.object({
  viewType: ViewTypeSchema.default('personal'),
  period: PeriodSchema.default('week'),
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
        ...getCreditBlocks(transactions, now, ctx.user, ctx.user.id),
        autoTopUpEnabled: ctx.user.auto_top_up_enabled,
      };
    }),

  getBalance: baseProcedure
    .output(z.object({ balance: z.number(), isDepleted: z.boolean() }))
    .query(async ({ ctx }) => {
      const { balance } = await getBalanceForUser(ctx.user);
      return { balance, isDepleted: balance <= 0 };
    }),

  getContextBalance: baseProcedure
    .input(z.object({ organizationId: z.string().uuid().optional() }))
    .output(z.object({ balance: z.number(), isDepleted: z.boolean() }))
    .query(async ({ ctx, input }) => {
      if (input.organizationId) {
        await ensureOrganizationAccess(ctx, input.organizationId);
      }
      const { balance } = await getBalanceAndOrgSettings(input.organizationId, ctx.user);
      return { balance, isDepleted: balance <= 0 };
    }),

  getAutocompleteMetrics: baseProcedure
    .input(AutocompleteMetricsInputSchema)
    .output(AutocompleteMetricsOutputSchema)
    .query(async ({ ctx, input }) => {
      const { viewType, period } = input;
      const userId = ctx.user.id;

      if (viewType !== 'personal' && viewType !== 'all') {
        await ensureOrganizationAccess(ctx, viewType);
      }

      const dateThreshold = getDateThreshold(period);

      // Build where conditions based on view type, filtering for autocomplete model
      const conditions = [
        eq(microdollar_usage.kilo_user_id, userId),
        eq(microdollar_usage.model, AUTOCOMPLETE_MODEL),
      ];

      if (viewType === 'personal') {
        conditions.push(isNull(microdollar_usage.organization_id));
      } else if (viewType !== 'all') {
        conditions.push(eq(microdollar_usage.organization_id, viewType));
      }

      if (dateThreshold) {
        conditions.push(gte(microdollar_usage.created_at, dateThreshold));
      }

      const result = await timedUsageQuery(
        {
          db: readDb,
          route: 'user.getAutocompleteMetrics',
          queryLabel: 'user_autocomplete_aggregate',
          scope: 'user',
          period,
        },
        tx =>
          tx
            .select({
              total_cost: sql<number>`COALESCE(SUM(${microdollar_usage.cost}), 0)::float`,
              request_count: sql<number>`COUNT(*)::float`,
              total_tokens: sql<number>`COALESCE(SUM(${microdollar_usage.input_tokens}) + SUM(${microdollar_usage.output_tokens}), 0)::float`,
            })
            .from(microdollar_usage)
            .where(and(...conditions))
      );

      const metrics = result[0] || {
        total_cost: 0,
        request_count: 0,
        total_tokens: 0,
      };

      return {
        cost: metrics.total_cost,
        requests: metrics.request_count,
        tokens: metrics.total_tokens,
      };
    }),

  toggleAutoTopUp: baseProcedure
    .input(
      z.object({
        currentEnabled: z.boolean(),
        amountCents: AutoTopUpAmountCentsSchema.optional(),
      })
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
    return {
      enabled: ctx.user.auto_top_up_enabled,
      amountCents,
      paymentMethod,
    };
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

  markWelcomeFormCompleted: baseProcedure.mutation(async ({ ctx }) => {
    await db
      .update(kilocode_users)
      .set({ completed_welcome_form: true })
      .where(eq(kilocode_users.id, ctx.user.id));
    return successResult();
  }),

  submitCustomerSource: baseProcedure
    .input(z.object({ source: z.string().trim().min(1).max(1000) }))
    .mutation(async ({ ctx, input }) => {
      await db
        .update(kilocode_users)
        .set({ customer_source: input.source })
        .where(eq(kilocode_users.id, ctx.user.id));
      return successResult();
    }),

  skipCustomerSource: baseProcedure.mutation(async ({ ctx }) => {
    await db
      .update(kilocode_users)
      .set({ customer_source: '' })
      .where(and(eq(kilocode_users.id, ctx.user.id), isNull(kilocode_users.customer_source)));
    return successResult();
  }),

  updateProfile: baseProcedure
    .input(
      z.object({
        linkedin_url: z
          .string()
          .url()
          .refine(val => /^https?:\/\//i.test(val), {
            message: 'URL must use http or https',
          })
          .nullable()
          .optional(),
        github_url: z
          .string()
          .url()
          .refine(val => /^https?:\/\//i.test(val), {
            message: 'URL must use http or https',
          })
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

  getDiscordGuildStatus: baseProcedure.query(async ({ ctx }) => {
    const discordProvider = await db.query.user_auth_provider.findFirst({
      where: and(
        eq(user_auth_provider.kilo_user_id, ctx.user.id),
        eq(user_auth_provider.provider, 'discord')
      ),
    });

    const user = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, ctx.user.id),
      columns: {
        discord_server_membership_verified_at: true,
      },
    });

    return successResult({
      linked: !!discordProvider,
      discord_avatar_url: discordProvider?.avatar_url ?? null,
      discord_display_name: discordProvider?.display_name ?? null,
      discord_server_membership_verified_at: user?.discord_server_membership_verified_at ?? null,
    });
  }),

  verifyDiscordGuildMembership: baseProcedure.mutation(async ({ ctx }) => {
    const discordProvider = await db.query.user_auth_provider.findFirst({
      where: and(
        eq(user_auth_provider.kilo_user_id, ctx.user.id),
        eq(user_auth_provider.provider, 'discord')
      ),
    });

    if (!discordProvider) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'No Discord account linked. Please connect your Discord account first.',
      });
    }

    let isMember: boolean;
    try {
      isMember = await checkDiscordGuildMembership(discordProvider.provider_account_id);
    } catch (error) {
      captureException(error);
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to verify Discord guild membership. Please try again later.',
      });
    }

    await db
      .update(kilocode_users)
      .set({
        discord_server_membership_verified_at: isMember ? new Date().toISOString() : null,
      })
      .where(eq(kilocode_users.id, ctx.user.id));

    return successResult({ is_member: isMember });
  }),
});

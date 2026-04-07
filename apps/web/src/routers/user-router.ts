import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { getUserAuthProviders, unlinkAuthProviderFromUser } from '@/lib/user';
import {
  sendAccountDeletionConfirmationEmail,
  sendAccountDeletionSupportNotification,
} from '@/lib/email';
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
  kiloclaw_instances,
  kiloclaw_subscriptions,
} from '@kilocode/db/schema';
import { eq, and, isNull, inArray, sql, gte } from 'drizzle-orm';
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

const ACCOUNT_DELETION_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

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

const CreditDeductionSchema = z.object({
  id: z.string(),
  date: z.string(),
  description: z.string(),
  amount_mUsd: z.number(),
});

const GetCreditBlocksOutputSchema = z.object({
  creditBlocks: z.array(CreditBlockSchema),
  deductions: z.array(CreditDeductionSchema),
  totalBalance_mUsd: z.number(),
  isFirstPurchase: z.boolean(),
  autoTopUpEnabled: z.boolean(),
});

type RawDeduction = {
  id: string;
  date: string;
  description: string;
  credit_category: string | null;
  amount_mUsd: number;
};

/**
 * Parse a KiloClaw instance ID from a credit_category string.
 *
 * Pure-credit categories:  `kiloclaw-subscription:{instanceId}:YYYY-MM`
 *                          `kiloclaw-subscription-commit:{instanceId}:YYYY-MM`
 * Settlement categories:   `kiloclaw-settlement:{stripeSubId}:YYYY-MM-DD`
 *
 * Returns the instance UUID for pure-credit categories, or null for
 * settlement categories (which embed the Stripe subscription ID instead).
 */
function parseInstanceIdFromCategory(category: string): string | null {
  const match = category.match(/^kiloclaw-subscription(?:-commit)?:([^:]+):/);
  if (!match) return null;
  // Validate it looks like a UUID to avoid false matches
  const candidate = match[1];
  if (!/^[0-9a-f-]{36}$/i.test(candidate)) return null;
  return candidate;
}

/**
 * Reformat a stored KiloClaw deduction description into the display format:
 *   "KiloClaw Hosting - Standard: Enrollment (Instance Name)"
 *
 * Stored descriptions follow these patterns:
 *   "KiloClaw standard enrollment"
 *   "KiloClaw commit renewal"
 *   "KiloClaw standard period deduction"
 */
function formatKiloClawDeductionDescription(
  storedDescription: string,
  instanceName: string | null
): string {
  const match = storedDescription.match(/^KiloClaw\s+(standard|commit)\s+(.+)$/i);
  if (!match) {
    // Unrecognized format — append instance name if available
    return instanceName ? `${storedDescription} (${instanceName})` : storedDescription;
  }
  const plan = match[1].toLowerCase() === 'commit' ? 'Commit' : 'Standard';
  const action = capitalizeFirst(match[2]);
  const suffix = instanceName ? ` (${instanceName})` : '';
  return `KiloClaw Hosting - ${plan}: ${action}${suffix}`;
}

function capitalizeFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Enrich KiloClaw deduction descriptions with instance names so users
 * can distinguish charges across multiple instances.
 */
async function enrichDeductionsWithInstanceNames(
  userId: string,
  deductions: RawDeduction[]
): Promise<{ id: string; date: string; description: string; amount_mUsd: number }[]> {
  // Collect unique instance IDs from pure-credit deduction categories.
  const instanceIds = new Set<string>();
  // Collect Stripe subscription IDs from settlement categories for lookup.
  const stripeSubIds = new Set<string>();

  for (const d of deductions) {
    if (!d.credit_category?.startsWith('kiloclaw-')) continue;
    const instanceId = parseInstanceIdFromCategory(d.credit_category);
    if (instanceId) {
      instanceIds.add(instanceId);
    } else {
      // Settlement category: kiloclaw-settlement:{stripeSubId}:...
      const settlementMatch = d.credit_category.match(/^kiloclaw-settlement:([^:]+):/);
      if (settlementMatch) stripeSubIds.add(settlementMatch[1]);
    }
  }

  // Batch-fetch instance names.
  const nameById = new Map<string, string | null>();

  if (instanceIds.size > 0) {
    const rows = await db
      .select({ id: kiloclaw_instances.id, name: kiloclaw_instances.name })
      .from(kiloclaw_instances)
      .where(inArray(kiloclaw_instances.id, [...instanceIds]));
    for (const r of rows) nameById.set(r.id, r.name);
  }

  // For settlement deductions, resolve Stripe subscription ID → instance ID → name.
  if (stripeSubIds.size > 0) {
    const subRows = await db
      .select({
        stripe_subscription_id: kiloclaw_subscriptions.stripe_subscription_id,
        instance_id: kiloclaw_subscriptions.instance_id,
      })
      .from(kiloclaw_subscriptions)
      .where(
        and(
          eq(kiloclaw_subscriptions.user_id, userId),
          inArray(kiloclaw_subscriptions.stripe_subscription_id, [...stripeSubIds])
        )
      );

    const missingInstanceIds = new Set<string>();
    const stripeToInstance = new Map<string, string>();
    for (const r of subRows) {
      if (r.stripe_subscription_id && r.instance_id) {
        stripeToInstance.set(r.stripe_subscription_id, r.instance_id);
        if (!nameById.has(r.instance_id)) missingInstanceIds.add(r.instance_id);
      }
    }

    if (missingInstanceIds.size > 0) {
      const rows = await db
        .select({ id: kiloclaw_instances.id, name: kiloclaw_instances.name })
        .from(kiloclaw_instances)
        .where(inArray(kiloclaw_instances.id, [...missingInstanceIds]));
      for (const r of rows) nameById.set(r.id, r.name);
    }

    // Map stripe sub IDs → instance names
    for (const [stripeSub, instId] of stripeToInstance) {
      // Store under the stripe sub key too for easy lookup
      nameById.set(`stripe:${stripeSub}`, nameById.get(instId) ?? null);
    }
  }

  return deductions.map(d => {
    let description = d.description;
    if (d.credit_category?.startsWith('kiloclaw-')) {
      const instanceId = parseInstanceIdFromCategory(d.credit_category);
      let instanceName: string | null = null;
      if (instanceId) {
        instanceName = nameById.get(instanceId) ?? null;
      } else {
        const settlementMatch = d.credit_category.match(/^kiloclaw-settlement:([^:]+):/);
        if (settlementMatch) {
          instanceName = nameById.get(`stripe:${settlementMatch[1]}`) ?? null;
        }
      }
      description = formatKiloClawDeductionDescription(description, instanceName);
    }
    return { id: d.id, date: d.date, description, amount_mUsd: d.amount_mUsd };
  });
}

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

      const result = getCreditBlocks(transactions, now, ctx.user, ctx.user.id);

      // Enrich KiloClaw deduction descriptions with instance names.
      const enrichedDeductions = await enrichDeductionsWithInstanceNames(
        ctx.user.id,
        result.deductions
      );

      return {
        ...result,
        deductions: enrichedDeductions,
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

  requestAccountDeletion: baseProcedure.mutation(async ({ ctx }) => {
    const userEmail = ctx.user.google_user_email;
    const userId = ctx.user.id;

    const lastRequested = ctx.user.account_deletion_requested_at;
    if (
      lastRequested &&
      Date.now() - new Date(lastRequested).getTime() < ACCOUNT_DELETION_COOLDOWN_MS
    ) {
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: 'Account deletion already requested. Please wait before trying again.',
      });
    }

    await Promise.all([
      sendAccountDeletionConfirmationEmail(userEmail),
      sendAccountDeletionSupportNotification(userEmail, userId),
    ]);

    await db
      .update(kilocode_users)
      .set({ account_deletion_requested_at: new Date().toISOString() })
      .where(eq(kilocode_users.id, userId));

    return successResult();
  }),
});

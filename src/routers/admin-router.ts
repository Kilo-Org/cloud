import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  user_admin_notes,
  kilocode_users,
  kilo_pass_subscriptions,
  stytch_fingerprints,
  enrichment_data,
  user_auth_provider,
  modelStats,
  cliSessions,
  cli_sessions_v2,
  credit_transactions,
} from '@kilocode/db/schema';
import { isNewSession } from '@/lib/cloud-agent/session-type';
import { fetchSessionSnapshot, type SessionMessage } from '@/lib/session-ingest-client';
import { adminAppBuilderRouter } from '@/routers/admin-app-builder-router';
import { adminDeploymentsRouter } from '@/routers/admin-deployments-router';
import { adminKiloclawInstancesRouter } from '@/routers/admin-kiloclaw-instances-router';
import { adminKiloclawVersionsRouter } from '@/routers/admin-kiloclaw-versions-router';
import { adminFeatureInterestRouter } from '@/routers/admin-feature-interest-router';
import { adminCodeReviewsRouter } from '@/routers/admin-code-reviews-router';
import { adminAIAttributionRouter } from '@/routers/admin-ai-attribution-router';
import { ossSponsorshipRouter } from '@/routers/admin/oss-sponsorship-router';
import { bulkUserCreditsRouter } from '@/routers/admin/bulk-user-credits-router';
import { adminWebhookTriggersRouter } from '@/routers/admin-webhook-triggers-router';
import { adminAlertingRouter } from '@/routers/admin-alerting-router';
import * as z from 'zod';
import { eq, and, ne, or, ilike, desc, asc, sql, isNull } from 'drizzle-orm';
import { findUsersByIds, findUserById } from '@/lib/user';
import { getBlobContent } from '@/lib/r2/cli-sessions';
import { toNonNullish } from '@/lib/utils';
import { TRPCError } from '@trpc/server';
import { assertNoError, successResult } from '@/lib/maybe-result';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@/lib/kilo-pass/usage-triggered-bonus';
import { getKiloPassStateForUser } from '@/lib/kilo-pass/state';
import {
  kilo_pass_issuances,
  kilo_pass_issuance_items,
  microdollar_usage,
} from '@kilocode/db/schema';
import { KiloPassIssuanceItemKind } from '@/lib/kilo-pass/enums';
import { fromMicrodollars } from '@/lib/utils';
import { sum } from 'drizzle-orm';
import { CRON_SECRET } from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';
import { revalidatePath } from 'next/cache';
import { recomputeUserBalances } from '@/lib/recomputeUserBalances';
import { getStripeInvoices } from '@/lib/stripe';
import { client as stripeClient } from '@/lib/stripe-client';
import { releaseScheduledChangeForSubscription } from '@/lib/kilo-pass/scheduled-change-release';
import { kilo_pass_scheduled_changes } from '@kilocode/db/schema';
import {
  getKilocodeRepoOpenPullRequestCounts,
  getKilocodeRepoOpenPullRequestsSummary,
  getKilocodeRepoRecentlyClosedExternalPRs,
  getKilocodeRepoRecentlyMergedExternalPRs,
} from '@/lib/github/open-pull-request-counts';

const SyncResponseSchema = z.object({
  success: z.boolean(),
  message: z.string().optional(),
});

type SyncResponse = z.infer<typeof SyncResponseSchema>;

function parseJsonSafe(text: string): unknown {
  return JSON.parse(text) as unknown;
}

const AddNoteSchema = z.object({
  kilo_user_id: z.string(),
  noteContent: z.string().min(1, 'Note content cannot be empty').trim(),
});

const DeleteNoteSchema = z.object({
  note_id: z.string(),
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sessionIdSchema = z
  .string()
  .min(1)
  .refine(s => UUID_REGEX.test(s) || s.startsWith('ses_'), {
    message: 'Must be a UUID or ses_-prefixed session ID',
  });

const ResetAPIKeySchema = z.object({
  userId: z.string(),
});

const CheckKiloPassSchema = z.object({
  userId: z.string(),
});

const ResetToMagicLinkLoginSchema = z.object({
  userId: z.string(),
});

const UpdateUserBlockStatusSchema = z.object({
  userId: z.string(),
  blocked_reason: z.string().nullable(),
});

const GetStytchFingerprintsSchema = z.object({
  kilo_user_id: z.string(),
  fingerprint_type: z
    .enum([
      'visitor_fingerprint',
      'browser_fingerprint',
      'network_fingerprint',
      'hardware_fingerprint',
    ])
    .default('visitor_fingerprint'),
});

const UpsertEnrichmentDataSchema = z.object({
  user_id: z.string(),
  github_enrichment_data: z.record(z.string(), z.unknown()).nullable().optional(),
  linkedin_enrichment_data: z.record(z.string(), z.unknown()).nullable().optional(),
  clay_enrichment_data: z.record(z.string(), z.unknown()).nullable().optional(),
});

const ModelStatsListSchema = z.object({
  page: z.number().min(1).default(1),
  limit: z.number().min(1).max(100).default(100),
  sortBy: z.enum(['name', 'openrouterId', 'createdAt', 'isActive']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
  isActive: z.enum(['true', 'false', '']).optional(),
});

const CreateModelSchema = z.object({
  openrouterId: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().optional(),
  aaSlug: z.string().optional(),
  isActive: z.boolean().default(true),
});

const UpdateModelSchema = z.object({
  id: z.string(),
  aaSlug: z.string().nullable().optional(),
  isActive: z.boolean().optional(),
  isFeatured: z.boolean().optional(),
  isStealth: z.boolean().optional(),
});

const GetUserInvoicesSchema = z.object({
  stripe_customer_id: z.string(),
});

const CancelAndRefundKiloPassSchema = z.object({
  userId: z.string(),
  reason: z.string().min(1, 'Reason is required').trim(),
});

export const adminRouter = createTRPCRouter({
  webhookTriggers: adminWebhookTriggersRouter,
  github: createTRPCRouter({
    getKilocodeOpenPullRequestCounts: adminProcedure.query(async () => {
      return getKilocodeRepoOpenPullRequestCounts({ ttlMs: 2 * 60_000 });
    }),

    getKilocodeOpenPullRequestsSummary: adminProcedure
      .input(z.object({ includeDrafts: z.boolean().optional() }).optional())
      .query(async ({ input }) => {
        return getKilocodeRepoOpenPullRequestsSummary({
          ttlMs: 2 * 60_000,
          includeDrafts: input?.includeDrafts ?? false,
        });
      }),

    getKilocodeRecentlyMergedExternalPRs: adminProcedure.query(async () => {
      return getKilocodeRepoRecentlyMergedExternalPRs({ ttlMs: 2 * 60_000, maxResults: 50 });
    }),

    getKilocodeRecentlyClosedExternalPRs: adminProcedure.query(async () => {
      return getKilocodeRepoRecentlyClosedExternalPRs({ ttlMs: 2 * 60_000, maxResults: 50 });
    }),
  }),

  users: createTRPCRouter({
    addNote: adminProcedure.input(AddNoteSchema).mutation(async ({ input, ctx }) => {
      const insertResult = await db
        .insert(user_admin_notes)
        .values({
          kilo_user_id: input.kilo_user_id,
          note_content: input.noteContent,
          admin_kilo_user_id: ctx.user.id,
        })
        .returning();

      return {
        ...insertResult[0],
        admin_kilo_user: ctx.user,
      };
    }),

    deleteNote: adminProcedure.input(DeleteNoteSchema).mutation(async ({ input }) => {
      const res = await db.delete(user_admin_notes).where(eq(user_admin_notes.id, input.note_id));
      return { success: (res.rowCount ?? 0) > 0 };
    }),

    resetAPIKey: adminProcedure.input(ResetAPIKeySchema).mutation(async ({ input }) => {
      await db
        .update(kilocode_users)
        .set({ api_token_pepper: crypto.randomUUID() })
        .where(eq(kilocode_users.id, input.userId));

      return successResult();
    }),

    checkKiloPass: adminProcedure.input(CheckKiloPassSchema).mutation(async ({ input }) => {
      const before = await db.query.kilocode_users.findFirst({
        columns: {
          microdollars_used: true,
          kilo_pass_threshold: true,
        },
        where: eq(kilocode_users.id, input.userId),
      });

      if (!before) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      await maybeIssueKiloPassBonusFromUsageThreshold({
        kiloUserId: input.userId,
        nowIso: new Date().toISOString(),
      });

      const after = await db.query.kilocode_users.findFirst({
        columns: {
          microdollars_used: true,
          kilo_pass_threshold: true,
        },
        where: eq(kilocode_users.id, input.userId),
      });

      return { before, after };
    }),

    resetToMagicLinkLogin: adminProcedure
      .input(ResetToMagicLinkLoginSchema)
      .mutation(async ({ input }) => {
        // Check if user has SSO (workos) provider - forbid reset for SSO users
        const ssoProvider = await db.query.user_auth_provider.findFirst({
          where: and(
            eq(user_auth_provider.kilo_user_id, input.userId),
            eq(user_auth_provider.provider, 'workos')
          ),
        });

        if (ssoProvider) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message:
              'Cannot reset to magic link login for SSO users. The user must authenticate through their organization SSO provider.',
          });
        }

        await db
          .delete(user_auth_provider)
          .where(eq(user_auth_provider.kilo_user_id, input.userId));

        return successResult();
      }),

    updateBlockStatus: adminProcedure
      .input(UpdateUserBlockStatusSchema)
      .mutation(async ({ input }) => {
        await db
          .update(kilocode_users)
          .set({ blocked_reason: input.blocked_reason })
          .where(eq(kilocode_users.id, input.userId));

        return successResult();
      }),

    getStytchFingerprints: adminProcedure
      .input(GetStytchFingerprintsSchema)
      .query(async ({ input }) => {
        const userId = input.kilo_user_id;
        const fingerprintType = input.fingerprint_type;

        const fingerprintsQuery = db
          .select({
            id: stytch_fingerprints.id,
            visitor_fingerprint: stytch_fingerprints.visitor_fingerprint,
            browser_fingerprint: stytch_fingerprints.browser_fingerprint,
            network_fingerprint: stytch_fingerprints.network_fingerprint,
            hardware_fingerprint: stytch_fingerprints.hardware_fingerprint,
            kilo_user_id: stytch_fingerprints.kilo_user_id,
            verdict_action: stytch_fingerprints.verdict_action,
            kilo_free_tier_allowed: stytch_fingerprints.kilo_free_tier_allowed,
            created_at: stytch_fingerprints.created_at,
            reasons: stytch_fingerprints.reasons,
          })
          .from(stytch_fingerprints);

        const userFingerprints = await fingerprintsQuery.where(
          eq(stytch_fingerprints.kilo_user_id, userId)
        );

        // Get all unique fingerprints of the selected type
        const uniqueFingerprints = [
          ...new Set(userFingerprints.map(fp => fp[fingerprintType]).filter(fp => fp != 'UNKNOWN')),
        ];

        // Find all other users with the same fingerprints (excluding current user)
        const relatedFingerprints =
          uniqueFingerprints.length > 0
            ? await fingerprintsQuery
                .where(
                  and(
                    ne(stytch_fingerprints.kilo_user_id, userId),
                    or(
                      ...uniqueFingerprints.map(fp => eq(stytch_fingerprints[fingerprintType], fp))
                    )
                  )
                )
                .limit(100)
            : [];

        const usersById = await findUsersByIds(relatedFingerprints.map(fp => fp.kilo_user_id));

        // Map over unique user IDs to build result
        const relatedUsers = relatedFingerprints.map(fp => {
          const user = toNonNullish(usersById.get(fp.kilo_user_id));
          return {
            ...fp,
            google_user_email: user.google_user_email,
            google_user_name: user.google_user_name,
            google_user_image_url: user.google_user_image_url,
            has_validation_stytch: user.has_validation_stytch,
            user_created_at: user.created_at,
          };
        });

        return {
          fingerprints: userFingerprints,
          relatedUsers,
          fingerprintType,
        };
      }),

    getKiloPassState: adminProcedure
      .input(z.object({ userId: z.string() }))
      .query(async ({ input }) => {
        const user = await db.query.kilocode_users.findFirst({
          columns: {
            microdollars_used: true,
            total_microdollars_acquired: true,
            kilo_pass_threshold: true,
          },
          where: eq(kilocode_users.id, input.userId),
        });

        if (!user) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        }

        const subscription = await getKiloPassStateForUser(db, input.userId);
        if (!subscription) {
          return {
            subscription: null,
            issuances: [],
            currentPeriodUsageUsd: null,
            thresholds: null,
          };
        }

        // Fetch all issuances with their items for this subscription
        const issuanceRows = await db
          .select({
            issueMonth: kilo_pass_issuances.issue_month,
            issuanceCreatedAt: kilo_pass_issuances.created_at,
            itemKind: kilo_pass_issuance_items.kind,
            itemAmountUsd: kilo_pass_issuance_items.amount_usd,
            itemCreatedAt: kilo_pass_issuance_items.created_at,
            bonusPercentApplied: kilo_pass_issuance_items.bonus_percent_applied,
          })
          .from(kilo_pass_issuances)
          .innerJoin(
            kilo_pass_issuance_items,
            eq(kilo_pass_issuance_items.kilo_pass_issuance_id, kilo_pass_issuances.id)
          )
          .where(eq(kilo_pass_issuances.kilo_pass_subscription_id, subscription.subscriptionId))
          .orderBy(desc(kilo_pass_issuances.issue_month), asc(kilo_pass_issuance_items.created_at));

        // Find the most recent base credit issuance to compute usage since
        const latestBaseIssuance = issuanceRows.find(
          r => r.itemKind === KiloPassIssuanceItemKind.Base
        );

        let currentPeriodUsageUsd: number | null = null;
        if (latestBaseIssuance) {
          const result = await db
            .select({
              totalCost_mUsd: sql<unknown>`COALESCE(${sum(microdollar_usage.cost)}, 0)`,
            })
            .from(microdollar_usage)
            .where(
              and(
                eq(microdollar_usage.kilo_user_id, input.userId),
                isNull(microdollar_usage.organization_id),
                sql`${microdollar_usage.created_at} >= ${latestBaseIssuance.itemCreatedAt}`,
                sql`${microdollar_usage.created_at} < now()`
              )
            );
          const raw = Number(result[0]?.totalCost_mUsd);
          currentPeriodUsageUsd = isNaN(raw) ? 0 : Math.round(fromMicrodollars(raw) * 100) / 100;
        }

        const effectiveThreshold =
          user.kilo_pass_threshold != null
            ? Math.max(0, user.kilo_pass_threshold - 1_000_000)
            : null;

        return {
          subscription: {
            ...subscription,
          },
          issuances: issuanceRows.map(r => ({
            issueMonth: r.issueMonth,
            issuanceCreatedAt: r.issuanceCreatedAt,
            itemKind: r.itemKind,
            itemAmountUsd: r.itemAmountUsd,
            itemCreatedAt: r.itemCreatedAt,
            bonusPercentApplied: r.bonusPercentApplied,
          })),
          currentPeriodUsageUsd,
          thresholds: {
            kiloPassThreshold_mUsd: user.kilo_pass_threshold,
            effectiveThreshold_mUsd: effectiveThreshold,
            microdollarsUsed: user.microdollars_used,
            totalMicrodollarsAcquired: user.total_microdollars_acquired,
            bonusUnlocked: user.kilo_pass_threshold === null,
          },
        };
      }),

    getInvoices: adminProcedure.input(GetUserInvoicesSchema).query(async ({ input }) => {
      const invoices = await getStripeInvoices(input.stripe_customer_id);
      return { invoices };
    }),

    recomputeBalances: adminProcedure
      .input(z.object({ userId: z.string(), dryRun: z.boolean().default(true) }))
      .mutation(async ({ input }) => {
        return assertNoError(await recomputeUserBalances(input));
      }),

    DEV_ONLY_messUpBalance: adminProcedure
      .input(z.object({ userId: z.string() }))
      .mutation(async ({ input }) => {
        if (process.env.NODE_ENV !== 'development') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'This endpoint is only available in development mode',
          });
        }

        // SQL expression for random jitter ±$1 (evaluated per-row)
        const jitterSql = sql`(random() - 0.5) * 2000000`;

        // Jitter user balance
        await db
          .update(kilocode_users)
          .set({
            microdollars_used: sql`${kilocode_users.microdollars_used} + ${jitterSql}`,
            total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} + ${jitterSql}`,
          })
          .where(eq(kilocode_users.id, input.userId));

        // Jitter all baselines for this user's personal credit transactions (each row gets different jitter)
        await db
          .update(credit_transactions)
          .set({
            original_baseline_microdollars_used: sql`${credit_transactions.original_baseline_microdollars_used} + ${jitterSql}`,
            expiration_baseline_microdollars_used: sql`CASE WHEN ${credit_transactions.expiration_baseline_microdollars_used} IS NOT NULL THEN ${credit_transactions.expiration_baseline_microdollars_used} + ${jitterSql} ELSE NULL END`,
          })
          .where(
            and(
              eq(credit_transactions.kilo_user_id, input.userId),
              isNull(credit_transactions.organization_id)
            )
          );

        return { success: true };
      }),

    cancelAndRefundKiloPass: adminProcedure
      .input(CancelAndRefundKiloPassSchema)
      .mutation(async ({ input, ctx }) => {
        const user = await db.query.kilocode_users.findFirst({
          columns: {
            id: true,
            stripe_customer_id: true,
            blocked_reason: true,
          },
          where: eq(kilocode_users.id, input.userId),
        });

        if (!user) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
        }

        const subscription = await getKiloPassStateForUser(db, input.userId);
        if (!subscription) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'No Kilo Pass subscription found for this user',
          });
        }

        if (subscription.status === 'canceled') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Kilo Pass subscription is already canceled',
          });
        }

        const scheduledChange = await db.query.kilo_pass_scheduled_changes.findFirst({
          columns: { stripe_schedule_id: true },
          where: and(
            eq(
              kilo_pass_scheduled_changes.stripe_subscription_id,
              subscription.stripeSubscriptionId
            ),
            isNull(kilo_pass_scheduled_changes.deleted_at)
          ),
        });

        if (scheduledChange) {
          await releaseScheduledChangeForSubscription({
            dbOrTx: db,
            stripe: stripeClient,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            stripeScheduleIdIfMissingRow: scheduledChange.stripe_schedule_id,
            kiloUserIdIfMissingRow: input.userId,
            reason: 'cancel_subscription',
          });
        }

        await stripeClient.subscriptions.cancel(subscription.stripeSubscriptionId);

        let refundedAmountCents: number | null = null;
        const paidInvoices = await stripeClient.invoices.list({
          subscription: subscription.stripeSubscriptionId,
          status: 'paid',
          limit: 1,
        });
        const paidInvoice = paidInvoices.data[0];
        if (paidInvoice) {
          const payments = await stripeClient.invoicePayments.list({
            invoice: paidInvoice.id,
            status: 'paid',
            limit: 1,
          });
          const rawPaymentIntent = payments.data[0]?.payment.payment_intent;
          const paymentIntentId =
            typeof rawPaymentIntent === 'string' ? rawPaymentIntent : rawPaymentIntent?.id;
          if (paymentIntentId) {
            try {
              const refund = await stripeClient.refunds.create({
                payment_intent: paymentIntentId,
              });
              refundedAmountCents = refund.amount;
            } catch (err) {
              if (
                !(err instanceof stripeClient.errors.StripeInvalidRequestError) ||
                err.code !== 'charge_already_refunded'
              ) {
                throw err;
              }
            }
          }
        }

        const balanceResetAmountUsd = await db.transaction(async tx => {
          await tx
            .update(kilo_pass_subscriptions)
            .set({
              status: 'canceled',
              cancel_at_period_end: false,
              ended_at: new Date().toISOString(),
              current_streak_months: 0,
            })
            .where(
              eq(kilo_pass_subscriptions.stripe_subscription_id, subscription.stripeSubscriptionId)
            );

          if (!user.blocked_reason) {
            await tx
              .update(kilocode_users)
              .set({ blocked_reason: input.reason })
              .where(eq(kilocode_users.id, input.userId));
          }

          const freshUserRows = await tx
            .select({
              microdollars_used: kilocode_users.microdollars_used,
              total_microdollars_acquired: kilocode_users.total_microdollars_acquired,
            })
            .from(kilocode_users)
            .where(eq(kilocode_users.id, input.userId))
            .for('update')
            .limit(1);
          const freshUser = freshUserRows[0];
          const currentBalanceMicrodollars = freshUser
            ? freshUser.total_microdollars_acquired - freshUser.microdollars_used
            : 0;

          let balanceReset: number | null = null;
          if (currentBalanceMicrodollars > 0 && freshUser) {
            await tx.insert(credit_transactions).values({
              kilo_user_id: input.userId,
              organization_id: null,
              is_free: true,
              amount_microdollars: -currentBalanceMicrodollars,
              credit_category: 'admin-cancel-refund-kilo-pass',
              description: `Balance zeroed by admin: ${input.reason}`,
              original_baseline_microdollars_used: freshUser.microdollars_used,
            });
            await tx
              .update(kilocode_users)
              .set({
                total_microdollars_acquired: sql`${kilocode_users.total_microdollars_acquired} - ${currentBalanceMicrodollars}`,
              })
              .where(eq(kilocode_users.id, input.userId));
            balanceReset = fromMicrodollars(currentBalanceMicrodollars);
          }

          const noteParts = [
            `Kilo Pass cancelled and refunded by admin.`,
            `Reason: ${input.reason}`,
            refundedAmountCents != null
              ? `Refunded: $${(refundedAmountCents / 100).toFixed(2)}`
              : 'No invoice to refund.',
            balanceReset != null
              ? `Balance reset: $${balanceReset.toFixed(2)} zeroed.`
              : 'Balance was already $0.',
            !user.blocked_reason ? 'Account blocked.' : 'Account was already blocked.',
          ];
          await tx.insert(user_admin_notes).values({
            kilo_user_id: input.userId,
            note_content: noteParts.join(' '),
            admin_kilo_user_id: ctx.user.id,
          });

          return balanceReset;
        });

        return {
          success: true,
          refundedAmountCents,
          balanceResetAmountUsd,
          alreadyBlocked: !!user.blocked_reason,
        };
      }),
  }),

  enrichmentData: createTRPCRouter({
    upsert: adminProcedure.input(UpsertEnrichmentDataSchema).mutation(async ({ input }) => {
      const { user_id, github_enrichment_data, linkedin_enrichment_data, clay_enrichment_data } =
        input;

      const user = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, user_id),
      });

      if (!user) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found',
        });
      }

      const existingData = await db.query.enrichment_data.findFirst({
        where: eq(enrichment_data.user_id, user_id),
      });

      const updateData: {
        github_enrichment_data?: unknown;
        linkedin_enrichment_data?: unknown;
        clay_enrichment_data?: unknown;
      } = {};

      if (github_enrichment_data !== undefined) {
        updateData.github_enrichment_data = github_enrichment_data;
      }
      if (linkedin_enrichment_data !== undefined) {
        updateData.linkedin_enrichment_data = linkedin_enrichment_data;
      }
      if (clay_enrichment_data !== undefined) {
        updateData.clay_enrichment_data = clay_enrichment_data;
      }

      let result;

      if (existingData) {
        const updated = await db
          .update(enrichment_data)
          .set(updateData)
          .where(eq(enrichment_data.user_id, user_id))
          .returning();

        result = updated[0];
      } else {
        const inserted = await db
          .insert(enrichment_data)
          .values({
            user_id,
            github_enrichment_data: github_enrichment_data ?? null,
            linkedin_enrichment_data: linkedin_enrichment_data ?? null,
            clay_enrichment_data: clay_enrichment_data ?? null,
          })
          .returning();

        result = inserted[0];
      }

      return successResult({ data: result });
    }),
  }),

  modelStats: createTRPCRouter({
    list: adminProcedure.input(ModelStatsListSchema).query(async ({ input }) => {
      const { page, limit, sortBy, sortOrder, search, isActive } = input;
      const offset = (page - 1) * limit;

      const conditions = [];

      if (search) {
        conditions.push(
          or(
            ilike(modelStats.name, `%${search}%`),
            ilike(modelStats.openrouterId, `%${search}%`),
            ilike(modelStats.slug, `%${search}%`)
          )
        );
      }

      if (isActive === 'true') {
        conditions.push(eq(modelStats.isActive, true));
      } else if (isActive === 'false') {
        conditions.push(eq(modelStats.isActive, false));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const sortByMap = {
        name: modelStats.name,
        openrouterId: modelStats.openrouterId,
        createdAt: modelStats.createdAt,
        isActive: modelStats.isActive,
      };

      const orderByColumn = sortByMap[sortBy];
      const orderFn = sortOrder === 'asc' ? asc : desc;

      const results = await db
        .select({
          id: modelStats.id,
          isActive: modelStats.isActive,
          isFeatured: modelStats.isFeatured,
          isStealth: modelStats.isStealth,
          openrouterId: modelStats.openrouterId,
          slug: modelStats.slug,
          aaSlug: modelStats.aaSlug,
          name: modelStats.name,
          description: modelStats.description,
          modelCreator: modelStats.modelCreator,
          creatorSlug: modelStats.creatorSlug,
          releaseDate: modelStats.releaseDate,
          priceInput: modelStats.priceInput,
          priceOutput: modelStats.priceOutput,
          codingIndex: modelStats.codingIndex,
          speedTokensPerSec: modelStats.speedTokensPerSec,
          contextLength: modelStats.contextLength,
          maxOutputTokens: modelStats.maxOutputTokens,
          inputModalities: modelStats.inputModalities,
          openrouterData: modelStats.openrouterData,
          benchmarks: modelStats.benchmarks,
          chartData: modelStats.chartData,
          createdAt: modelStats.createdAt,
          updatedAt: modelStats.updatedAt,
          total: sql<number>`count(*) OVER()::int`.as('total'),
          mostRecentUpdate: sql<string>`MAX(${modelStats.updatedAt}) OVER()`.as(
            'most_recent_update'
          ),
        })
        .from(modelStats)
        .where(whereClause)
        .orderBy(orderFn(orderByColumn))
        .limit(limit)
        .offset(offset);

      const total = results[0]?.total || 0;
      const lastUpdated = results[0]?.mostRecentUpdate || null;

      return {
        models: results.map(({ total: _, mostRecentUpdate: __, ...model }) => model),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
        lastUpdated,
      };
    }),

    create: adminProcedure.input(CreateModelSchema).mutation(async ({ input }) => {
      const [newModel] = await db
        .insert(modelStats)
        .values({
          openrouterId: input.openrouterId,
          name: input.name,
          slug: input.slug || null,
          aaSlug: input.aaSlug || null,
          isActive: input.isActive,
          openrouterData: sql`'{}'::jsonb`,
        })
        .returning();

      revalidatePath('/api/models/stats');

      return newModel;
    }),

    update: adminProcedure.input(UpdateModelSchema).mutation(async ({ input }) => {
      const { id, ...data } = input;

      const [updatedModel] = await db
        .update(modelStats)
        .set(data)
        .where(eq(modelStats.id, id))
        .returning();

      if (!updatedModel) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Model not found',
        });
      }

      revalidatePath('/api/models/stats');

      return updatedModel;
    }),

    triggerSync: adminProcedure.mutation(async (): Promise<SyncResponse> => {
      const cronUrl = `${APP_URL}/api/cron/sync-model-stats`;
      const response = await fetch(cronUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${CRON_SECRET}`,
        },
      });

      if (!response.ok) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to trigger stats update',
        });
      }

      const text = await response.text();
      const parsed = parseJsonSafe(text);
      return SyncResponseSchema.parse(parsed);
    }),

    bustCache: adminProcedure.mutation(() => {
      revalidatePath('/api/models/stats');
      revalidatePath('/api/models/stats/[slug]', 'page');
      return { success: true, message: 'Cache busted successfully' };
    }),
  }),

  deployments: adminDeploymentsRouter,

  alerting: adminAlertingRouter,

  featureInterest: adminFeatureInterestRouter,

  codeReviews: adminCodeReviewsRouter,

  sessionTraces: createTRPCRouter({
    resolveCloudAgentSession: adminProcedure
      .input(z.object({ cloud_agent_session_id: z.string().startsWith('agent_') }))
      .query(async ({ input }) => {
        // Check v1 first
        const [v1] = await db
          .select({ session_id: cliSessions.session_id })
          .from(cliSessions)
          .where(eq(cliSessions.cloud_agent_session_id, input.cloud_agent_session_id))
          .limit(1);

        if (v1) {
          return { session_id: v1.session_id };
        }

        // Then check v2
        const [v2] = await db
          .select({ session_id: cli_sessions_v2.session_id })
          .from(cli_sessions_v2)
          .where(eq(cli_sessions_v2.cloud_agent_session_id, input.cloud_agent_session_id))
          .limit(1);

        if (v2) {
          return { session_id: v2.session_id };
        }

        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'No CLI session found for this cloud agent session ID',
        });
      }),

    get: adminProcedure
      .input(z.object({ session_id: sessionIdSchema }))
      .query(async ({ input }) => {
        if (isNewSession(input.session_id)) {
          // V2 session — query cli_sessions_v2
          const [session] = await db
            .select()
            .from(cli_sessions_v2)
            .where(eq(cli_sessions_v2.session_id, input.session_id))
            .limit(1);

          if (!session) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Session not found',
            });
          }

          const user = await findUserById(session.kilo_user_id);

          return {
            ...session,
            // Fields that don't exist in v2 — null them out so the UI can handle both shapes
            last_mode: null,
            last_model: null,
            user: user
              ? {
                  id: user.id,
                  email: user.google_user_email,
                  name: user.google_user_name,
                  image: user.google_user_image_url,
                }
              : null,
          };
        }

        // V1 session — original logic
        const [session] = await db
          .select()
          .from(cliSessions)
          .where(eq(cliSessions.session_id, input.session_id))
          .limit(1);

        if (!session) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Session not found',
          });
        }

        const user = await findUserById(session.kilo_user_id);

        return {
          ...session,
          // V1 doesn't have git_branch — null it out for a consistent shape
          git_branch: null,
          user: user
            ? {
                id: user.id,
                email: user.google_user_email,
                name: user.google_user_name,
                image: user.google_user_image_url,
              }
            : null,
        };
      }),

    getMessages: adminProcedure
      .input(z.object({ session_id: sessionIdSchema }))
      .query(async ({ input }) => {
        if (isNewSession(input.session_id)) {
          // V2 session — fetch messages from the session-ingest worker.
          // We need the owner's kilo_user_id to generate a service token.
          const [session] = await db
            .select({ kilo_user_id: cli_sessions_v2.kilo_user_id })
            .from(cli_sessions_v2)
            .where(eq(cli_sessions_v2.session_id, input.session_id))
            .limit(1);

          if (!session) {
            throw new TRPCError({
              code: 'NOT_FOUND',
              message: 'Session not found',
            });
          }

          try {
            const snapshot = await fetchSessionSnapshot(input.session_id, session.kilo_user_id);
            return {
              messages: snapshot?.messages ?? ([] satisfies SessionMessage[]),
              format: 'v2' as const,
            };
          } catch (error) {
            console.error('[SessionTraces] Failed to fetch v2 session snapshot', {
              sessionId: input.session_id,
              error,
            });
            return { messages: [], format: 'v2' as const };
          }
        }

        // V1 session — original logic
        const [session] = await db
          .select({
            ui_messages_blob_url: cliSessions.ui_messages_blob_url,
          })
          .from(cliSessions)
          .where(eq(cliSessions.session_id, input.session_id))
          .limit(1);

        if (!session) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Session not found',
          });
        }

        if (!session.ui_messages_blob_url) {
          return { messages: [], format: 'v1' as const };
        }

        try {
          const messages = await getBlobContent(session.ui_messages_blob_url);
          return { messages: (messages as unknown[]) ?? [], format: 'v1' as const };
        } catch {
          return { messages: [], format: 'v1' as const };
        }
      }),

    getApiConversationHistory: adminProcedure
      .input(z.object({ session_id: sessionIdSchema }))
      .query(async ({ input }) => {
        if (isNewSession(input.session_id)) {
          // V2 sessions have no separate raw API conversation history
          return { history: null };
        }

        // V1 session — original logic
        const [session] = await db
          .select({
            api_conversation_history_blob_url: cliSessions.api_conversation_history_blob_url,
          })
          .from(cliSessions)
          .where(eq(cliSessions.session_id, input.session_id))
          .limit(1);

        if (!session) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Session not found',
          });
        }

        if (!session.api_conversation_history_blob_url) {
          return { history: null };
        }

        try {
          const history = await getBlobContent(session.api_conversation_history_blob_url);
          return { history: history ?? null };
        } catch {
          return { history: null };
        }
      }),
  }),
  appBuilder: adminAppBuilderRouter,
  kiloclawInstances: adminKiloclawInstancesRouter,
  kiloclawVersions: adminKiloclawVersionsRouter,
  aiAttribution: adminAIAttributionRouter,
  ossSponsorship: ossSponsorshipRouter,
  bulkUserCredits: bulkUserCreditsRouter,
});

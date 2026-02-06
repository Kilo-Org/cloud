import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  user_admin_notes,
  kilocode_users,
  stytch_fingerprints,
  enrichment_data,
  user_auth_provider,
  modelStats,
  cliSessions,
  credit_transactions,
} from '@/db/schema';
import { adminAppBuilderRouter } from '@/routers/admin-app-builder-router';
import { adminDeploymentsRouter } from '@/routers/admin-deployments-router';
import { adminFeatureInterestRouter } from '@/routers/admin-feature-interest-router';
import { adminCodeReviewsRouter } from '@/routers/admin-code-reviews-router';
import { adminAIAttributionRouter } from '@/routers/admin-ai-attribution-router';
import { ossSponsorshipRouter } from '@/routers/admin/oss-sponsorship-router';
import { adminWebhookTriggersRouter } from '@/routers/admin-webhook-triggers-router';
import * as z from 'zod';
import { eq, and, ne, or, ilike, desc, asc, sql, isNull } from 'drizzle-orm';
import { findUsersByIds, findUserById } from '@/lib/user';
import { getBlobContent } from '@/lib/r2/cli-sessions';
import { toNonNullish } from '@/lib/utils';
import { TRPCError } from '@trpc/server';
import { assertNoError, successResult } from '@/lib/maybe-result';
import { maybeIssueKiloPassBonusFromUsageThreshold } from '@/lib/kilo-pass/usage-triggered-bonus';
import { CRON_SECRET } from '@/lib/config.server';
import { APP_URL } from '@/lib/constants';
import { revalidatePath } from 'next/cache';
import { recomputeUserBalances } from '@/lib/recomputeUserBalances';
import { getStripeInvoices } from '@/lib/stripe';
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

  featureInterest: adminFeatureInterestRouter,

  codeReviews: adminCodeReviewsRouter,

  sessionTraces: createTRPCRouter({
    get: adminProcedure
      .input(z.object({ session_id: z.string().uuid() }))
      .query(async ({ input }) => {
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
      .input(z.object({ session_id: z.string().uuid() }))
      .query(async ({ input }) => {
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
          return { messages: [] };
        }

        try {
          const messages = await getBlobContent(session.ui_messages_blob_url);
          return { messages: (messages as unknown[]) ?? [] };
        } catch {
          return { messages: [] };
        }
      }),

    getApiConversationHistory: adminProcedure
      .input(z.object({ session_id: z.string().uuid() }))
      .query(async ({ input }) => {
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
  aiAttribution: adminAIAttributionRouter,
  ossSponsorship: ossSponsorshipRouter,
});

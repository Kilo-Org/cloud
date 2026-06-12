import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  organizations,
  organization_memberships,
  kilocode_users,
  organization_seats_purchases,
  credit_transactions,
  platform_integrations,
  kilo_pass_subscriptions,
} from '@kilocode/db/schema';
import {
  ilike,
  or,
  asc,
  desc,
  count,
  eq,
  ne,
  gt,
  and,
  isNull,
  inArray,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import * as z from 'zod';
import { OrganizationsApiGetResponseSchema } from '@/types/admin';
import { STRIPE_SUBSCRIPTION_STATUS_VALUES } from '@/lib/admin/stripe-subscription-statuses';
import { isValidUUID, toMicrodollars } from '@/lib/utils';
import { millisecondsInHour } from 'date-fns/constants';
import {
  createOrganization,
  getOrganizationById,
  addUserToOrganization,
  markOrganizationAsDeleted,
} from '@/lib/organizations/organizations';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import { findUserById } from '@/lib/user';
import { TRPCError } from '@trpc/server';
import { successResult } from '@/lib/maybe-result';
import { reportEvents } from '@/lib/ai-gateway/abuse-service';
import { getMostRecentSeatPurchase } from '@/lib/organizations/organization-seats';
import {
  ORGANIZATION_TRIAL_ACTIVE_MIN_DAYS_REMAINING,
  ORGANIZATION_TRIAL_DURATION_DAYS,
} from '@kilocode/organization-entitlement';

const OrganizationListInputSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100_000).default(25),
  sortBy: z
    .enum([
      'name',
      'microdollars_used',
      'balance',
      'member_count',
      'plan',
      'kilo_pass_tier',
      'latest_stripe_status',
      'subscription_amount_usd',
    ])
    .default('name'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional().default(''),
  // mode controls which broad set of orgs to show (page-level, not user-facing)
  // paying = has ever had a seats purchase (active or churned customers)
  // trial  = has never had a seats purchase
  mode: z.enum(['paying', 'trial', 'all']).default('paying'),
  // User-facing filters
  include_deleted: z.boolean().default(false),
  // Filter by latest subscription_status value. Values match the canonical
  // Stripe status registry; '' clears the filter.
  stripe_status: z.union([z.enum(STRIPE_SUBSCRIPTION_STATUS_VALUES), z.literal('')]).optional(),
  plan: z.enum(['enterprise', 'teams', '']).optional(),
  // Trial-tab filters: hide orgs with no recorded usage / a single member.
  has_usage: z.boolean().default(false),
  has_multiple_users: z.boolean().default(false),
  // When true, only orgs whose effective trial end keeps them trial_active.
  trial_ending_in_future: z.boolean().default(false),
});

const OrganizationSearchInputSchema = z.object({
  search: z.string().min(1),
  limit: z.number().int().min(1).max(50).default(10),
});

const OrganizationSearchResultSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const OrganizationCreateInputSchema = z.object({
  name: z.string().min(1, 'Organization name is required').trim(),
});

const OrganizationIdInputSchema = z.object({
  organizationId: z.uuid(),
});

const UpdateCreatedByInputSchema = z.object({
  organizationId: z.uuid(),
  userId: z.string().uuid().nullable(),
});

const UpdateFreeTrialEndAtInputSchema = z.object({
  organizationId: z.uuid(),
  free_trial_end_at: z.string().datetime().nullable(),
});

const UpdateSuppressTrialMessagingInputSchema = z.object({
  organizationId: z.uuid(),
  suppress_trial_messaging: z.boolean(),
});

const AdminOrganizationDetailsSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  total_microdollars_acquired: z.number(),
  microdollars_used: z.number(),
  created_by_kilo_user_id: z.string().nullable(),
  created_by_user_email: z.string().nullable(),
  created_by_user_name: z.string().nullable(),
});

const GrantCreditInputSchema = z
  .object({
    organizationId: z.uuid(),
    amount_usd: z.number().refine(n => n !== 0, 'Amount cannot be zero'),
    description: z.string().optional(),
    expiry_date: z.string().datetime().nullable().optional(),
    expiry_hours: z.number().positive().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    if (data.amount_usd < 0 && (!data.description || data.description.trim().length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Description is required when granting negative credits',
        path: ['description'],
      });
    }
  });

const GrantCreditOutputSchema = z.object({
  message: z.string(),
  amount_usd: z.number(),
});

const NullifyCreditsInputSchema = z.object({
  organizationId: z.uuid(),
  description: z.string().optional(),
});

const NullifyCreditsOutputSchema = z.object({
  message: z.string(),
  amount_usd_nullified: z.number(),
});

const OrganizationMetricsSchema = z.object({
  activeOrgCount: z.number(),
  teamsCount: z.number(),
  enterpriseCount: z.number(),
  totalSeats: z.number(),
});

const AddMemberInputSchema = z.object({
  organizationId: z.uuid(),
  userId: z.string(),
  role: z.enum(['owner', 'member', 'billing_manager']),
});

export const organizationAdminRouter = createTRPCRouter({
  create: adminProcedure.input(OrganizationCreateInputSchema).mutation(async opts => {
    const organization = await createOrganization(opts.input.name);
    // create stripe customer id on org creation
    await getOrCreateStripeCustomerIdForOrganization(organization.id);
    return { organization };
  }),

  updateCreatedBy: adminProcedure.input(UpdateCreatedByInputSchema).mutation(async ({ input }) => {
    const { organizationId, userId } = input;

    // Validate that the organization exists
    const organization = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
    });

    if (!organization) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
      });
    }

    // If userId is provided, validate that the user exists
    if (userId !== null) {
      const user = await db.query.kilocode_users.findFirst({
        where: eq(kilocode_users.id, userId),
      });

      if (!user) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'User not found',
        });
      }
    }

    await db
      .update(organizations)
      .set({ created_by_kilo_user_id: userId })
      .where(eq(organizations.id, organizationId));

    return successResult();
  }),

  updateFreeTrialEndAt: adminProcedure
    .input(UpdateFreeTrialEndAtInputSchema)
    .mutation(async ({ input }) => {
      const { organizationId, free_trial_end_at } = input;

      // Validate that the organization exists
      const organization = await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
      });
      if (!organization) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }

      await db
        .update(organizations)
        .set({ free_trial_end_at })
        .where(eq(organizations.id, organizationId));

      return successResult();
    }),

  updateSuppressTrialMessaging: adminProcedure
    .input(UpdateSuppressTrialMessagingInputSchema)
    .mutation(async ({ input }) => {
      const { organizationId, suppress_trial_messaging } = input;

      // Validate that the organization exists
      const organization = await db.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
      });
      if (!organization) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
      }

      // Update the settings JSONB column
      const updatedSettings = {
        ...organization.settings,
        suppress_trial_messaging,
      };

      await db
        .update(organizations)
        .set({ settings: updatedSettings })
        .where(eq(organizations.id, organizationId));

      return successResult();
    }),

  getDetails: adminProcedure
    .input(OrganizationIdInputSchema)
    .output(AdminOrganizationDetailsSchema)
    .query(async ({ input }) => {
      const { organizationId } = input;

      const organizationDetails = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          created_at: organizations.created_at,
          updated_at: organizations.updated_at,
          total_microdollars_acquired: organizations.total_microdollars_acquired,
          microdollars_used: organizations.microdollars_used,
          created_by_kilo_user_id: organizations.created_by_kilo_user_id,
          created_by_user_email: kilocode_users.google_user_email,
          created_by_user_name: kilocode_users.google_user_name,
        })
        .from(organizations)
        .leftJoin(kilocode_users, eq(organizations.created_by_kilo_user_id, kilocode_users.id))
        .where(eq(organizations.id, organizationId))
        .limit(1);

      if (!organizationDetails || organizationDetails.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      return organizationDetails[0];
    }),

  grantCredit: adminProcedure
    .input(GrantCreditInputSchema)
    .output(GrantCreditOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, amount_usd, description } = input;
      const { user } = ctx;

      const existingOrg = await getOrganizationById(organizationId);
      if (!existingOrg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      const amountMicrodollars = toMicrodollars(amount_usd);

      const explicit_expiry_date = input.expiry_date ? new Date(input.expiry_date) : null;
      const expiryFromHours = input.expiry_hours
        ? new Date(Date.now() + input.expiry_hours * millisecondsInHour)
        : null;
      // Negative grants must not expire (expiring a negative would mint credits)
      const credit_expiry_date =
        amount_usd < 0
          ? null
          : explicit_expiry_date && expiryFromHours
            ? explicit_expiry_date < expiryFromHours
              ? explicit_expiry_date
              : expiryFromHours
            : (explicit_expiry_date ?? expiryFromHours);

      await db.transaction(async tx => {
        const [org] = await tx
          .select({ microdollars_used: organizations.microdollars_used })
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .for('update');

        await tx.insert(credit_transactions).values({
          kilo_user_id: user.id,
          is_free: true,
          amount_microdollars: amountMicrodollars,
          description: description?.trim() || 'Admin credit grant',
          credit_category: 'organization_custom',
          expiry_date: credit_expiry_date?.toISOString() ?? null,
          organization_id: organizationId,
          original_baseline_microdollars_used: org?.microdollars_used ?? 0,
          expiration_baseline_microdollars_used: credit_expiry_date
            ? (org?.microdollars_used ?? 0)
            : null,
        });

        await tx
          .update(organizations)
          .set({
            total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} + ${amountMicrodollars}`,
            microdollars_balance: sql`${organizations.microdollars_balance} + ${amountMicrodollars}`,
            ...(credit_expiry_date && {
              next_credit_expiration_at: sql`COALESCE(LEAST(${organizations.next_credit_expiration_at}, ${credit_expiry_date.toISOString()}), ${credit_expiry_date.toISOString()})`,
            }),
          })
          .where(eq(organizations.id, organizationId));
      });

      if (amountMicrodollars > 0 && existingOrg.created_by_kilo_user_id) {
        void reportEvents({
          events: [
            {
              type: 'billing.credit_purchased',
              data: {
                kilo_user_id: existingOrg.created_by_kilo_user_id,
                microdollars_acquired: amountMicrodollars,
              },
            },
          ],
        });
      }

      return {
        message: `Successfully granted $${amount_usd} credits to organization ${existingOrg.name}`,
        amount_usd,
      };
    }),

  nullifyCredits: adminProcedure
    .input(NullifyCreditsInputSchema)
    .output(NullifyCreditsOutputSchema)
    .mutation(async ({ input, ctx }) => {
      const { organizationId, description } = input;
      const { user } = ctx;

      const result = await db.transaction(async tx => {
        const [lockedOrg] = await tx
          .select({
            total_microdollars_acquired: organizations.total_microdollars_acquired,
            microdollars_used: organizations.microdollars_used,
            name: organizations.name,
          })
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .for('update');

        if (!lockedOrg) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Organization not found',
          });
        }

        const currentBalance = lockedOrg.total_microdollars_acquired - lockedOrg.microdollars_used;

        if (currentBalance <= 0) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Organization has no credits to nullify',
          });
        }

        await tx.insert(credit_transactions).values({
          kilo_user_id: user.id,
          is_free: true,
          amount_microdollars: -currentBalance,
          description: description?.trim() || 'Admin credit nullification',
          credit_category: 'organization_custom',
          expiry_date: null,
          organization_id: organizationId,
          original_baseline_microdollars_used: lockedOrg.microdollars_used,
        });

        await tx
          .update(organizations)
          .set({
            total_microdollars_acquired: sql`${organizations.microdollars_used}`,
            microdollars_balance: 0,
            next_credit_expiration_at: null,
          })
          .where(eq(organizations.id, organizationId));

        return {
          orgName: lockedOrg.name,
          amountUsdNullified: currentBalance / 1_000_000,
        };
      });

      return {
        message: `Successfully nullified $${result.amountUsdNullified.toFixed(2)} credits from organization ${result.orgName}`,
        amount_usd_nullified: result.amountUsdNullified,
      };
    }),

  getMetrics: adminProcedure.output(OrganizationMetricsSchema).query(async () => {
    // "Paying" = has at least one seats purchase record, not deleted
    const payingCondition = and(
      isNull(organizations.deleted_at),
      sql`EXISTS (
        SELECT 1 FROM ${organization_seats_purchases}
        WHERE ${organization_seats_purchases.organization_id} = ${organizations.id}
      )`
    );

    const [activeResult] = await db
      .select({ orgCount: count() })
      .from(organizations)
      .where(payingCondition);

    const [teamsResult] = await db
      .select({ orgCount: count() })
      .from(organizations)
      .where(and(payingCondition, eq(organizations.plan, 'teams')));

    const [enterpriseResult] = await db
      .select({ orgCount: count() })
      .from(organizations)
      .where(and(payingCondition, eq(organizations.plan, 'enterprise')));

    const [seatsResult] = await db
      .select({ totalSeats: sql<number>`COALESCE(SUM(${organizations.seat_count}), 0)::int` })
      .from(organizations)
      .where(payingCondition);

    return {
      activeOrgCount: activeResult?.orgCount ?? 0,
      teamsCount: teamsResult?.orgCount ?? 0,
      enterpriseCount: enterpriseResult?.orgCount ?? 0,
      totalSeats: seatsResult?.totalSeats ?? 0,
    };
  }),

  addMember: adminProcedure.input(AddMemberInputSchema).mutation(async ({ input }) => {
    const { organizationId, userId, role } = input;

    const organization = await getOrganizationById(organizationId);
    if (!organization) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
      });
    }

    const existingUser = await findUserById(userId);
    if (!existingUser) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'User not found',
      });
    }

    await addUserToOrganization(organizationId, userId, role);

    return successResult();
  }),

  delete: adminProcedure.input(OrganizationIdInputSchema).mutation(async ({ input }) => {
    const { organizationId } = input;

    const existingOrg = await getOrganizationById(organizationId);
    if (!existingOrg) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
      });
    }

    // Block deletion while a non-ended subscription exists (Subscription Lifecycle rule 10)
    const latestPurchase = await getMostRecentSeatPurchase(organizationId);
    if (latestPurchase && latestPurchase.subscription_status !== 'ended') {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message:
          'Cannot delete organization with an active subscription. Cancel the subscription first.',
      });
    }

    // Secondary guard: check Stripe directly in case a live subscription exists
    // but the webhook hasn't recorded it locally yet (e.g., checkout just completed).
    if (existingOrg.stripe_customer_id) {
      const { getSubscriptionsForStripeCustomerId } = await import('@/lib/stripe');
      const stripeSubs = await getSubscriptionsForStripeCustomerId(existingOrg.stripe_customer_id);
      if (stripeSubs.some(sub => sub.ended_at == null)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            'Cannot delete organization with an active subscription. Cancel the subscription first.',
        });
      }
    }

    await markOrganizationAsDeleted(organizationId);

    if (existingOrg.created_by_kilo_user_id) {
      void reportEvents({
        events: [
          {
            type: 'org.deleted',
            data: {
              kilo_user_id: existingOrg.created_by_kilo_user_id,
              organization_id: organizationId,
            },
          },
        ],
      });
    }

    return successResult();
  }),

  list: adminProcedure
    .input(OrganizationListInputSchema)
    .output(OrganizationsApiGetResponseSchema)
    .query(async ({ input }) => {
      // Single-source-of-truth for "has platform X integration" — keeps the
      // active/pending status set defined in one place across github, gitlab,
      // slack so future status rule changes can't drift between platforms.
      const hasPlatformIntegrationSql = (
        platform: 'github' | 'gitlab' | 'slack',
        orgIdColumn: PgColumn
      ): SQL<boolean> =>
        sql<boolean>`EXISTS (SELECT 1 FROM ${platform_integrations} pi WHERE pi.owned_by_organization_id = ${orgIdColumn} AND pi.platform = ${platform} AND pi.integration_status IN ('active', 'pending'))`;

      const {
        page,
        limit,
        sortBy,
        sortOrder,
        search,
        mode,
        include_deleted,
        stripe_status,
        plan,
        has_usage,
        has_multiple_users,
        trial_ending_in_future,
      } = input;

      const searchTerm = search.trim();
      const sortField = sortBy;
      const sortsByKiloPassTier = sortField === 'kilo_pass_tier';

      const conditions = [];

      if (searchTerm) {
        const searchConditions = [
          ilike(organizations.name, `%${searchTerm}%`),
          eq(organizations.stripe_customer_id, searchTerm),
        ];

        if (isValidUUID(searchTerm)) {
          searchConditions.push(eq(organizations.id, searchTerm));
        }

        conditions.push(or(...searchConditions));
      }

      if (plan === 'enterprise') {
        conditions.push(eq(organizations.plan, 'enterprise'));
      } else if (plan === 'teams') {
        conditions.push(eq(organizations.plan, 'teams'));
      }

      // Deleted filter: unless include_deleted is true, hide soft-deleted orgs
      if (!include_deleted) {
        conditions.push(isNull(organizations.deleted_at));
      }

      // Trial-tab filter: only orgs that have actually used credits.
      if (has_usage) {
        conditions.push(gt(organizations.microdollars_used, 0));
      }

      // Trial-tab filter: only orgs whose effective trial end maps to the
      // trial_active entitlement stage. Match the entitlement fallback for orgs
      // that never had free_trial_end_at persisted.
      if (trial_ending_in_future) {
        conditions.push(
          sql`COALESCE(${organizations.free_trial_end_at}, ${organizations.created_at} + ${ORGANIZATION_TRIAL_DURATION_DAYS} * INTERVAL '1 day') >= NOW() + ${ORGANIZATION_TRIAL_ACTIVE_MIN_DAYS_REMAINING} * INTERVAL '1 day'`
        );
      }

      const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

      // Subquery to get the latest subscription per organization (any status).
      // Declared before orderCondition so derived sort keys (Stripe status,
      // Subscription) can reference it.
      const latestSubscriptions = db
        .select({
          organization_id: organization_seats_purchases.organization_id,
          amount_usd: organization_seats_purchases.amount_usd,
          subscription_status: organization_seats_purchases.subscription_status,
          row_num:
            sql<number>`ROW_NUMBER() OVER (PARTITION BY ${organization_seats_purchases.organization_id} ORDER BY ${organization_seats_purchases.created_at} DESC)`.as(
              'row_num'
            ),
        })
        .from(organization_seats_purchases)
        .as('latest_subscriptions');

      const organizationKiloPassTiers = db
        .select({
          organization_id: organization_memberships.organization_id,
          kilo_pass_tier: sql<string | null>`MIN(${kilo_pass_subscriptions.tier})`.as(
            'kilo_pass_tier'
          ),
        })
        .from(organization_memberships)
        .innerJoin(
          kilo_pass_subscriptions,
          eq(kilo_pass_subscriptions.kilo_user_id, organization_memberships.kilo_user_id)
        )
        .where(eq(kilo_pass_subscriptions.status, 'active'))
        .groupBy(organization_memberships.organization_id)
        .as('organization_kilo_pass_tiers');

      let orderCondition;
      const orderFunction = sortOrder === 'asc' ? asc : desc;
      // For sort keys that come from a derived/aggregate column or a joined
      // table, build an explicit drizzle expression. Plain organizations columns
      // fall through to indexing into the table object.
      if (sortField === 'member_count') {
        orderCondition = orderFunction(count(kilocode_users.id));
      } else if (sortField === 'balance') {
        orderCondition = orderFunction(
          sql`${organizations.total_microdollars_acquired} - ${organizations.microdollars_used}`
        );
      } else if (sortField === 'subscription_amount_usd') {
        orderCondition = orderFunction(
          sql`CASE WHEN ${latestSubscriptions.subscription_status} IN ('active','trialing','past_due') THEN ${latestSubscriptions.amount_usd}::float8 ELSE NULL END`
        );
      } else if (sortField === 'latest_stripe_status') {
        orderCondition = orderFunction(latestSubscriptions.subscription_status);
      } else if (sortField === 'kilo_pass_tier') {
        orderCondition = orderFunction(organizationKiloPassTiers.kilo_pass_tier);
      } else {
        // 'name', 'plan', 'microdollars_used' all map to organizations columns.
        orderCondition = orderFunction(organizations[sortField]);
      }

      const organizationFields = {
        id: organizations.id,
        name: organizations.name,
        created_at: organizations.created_at,
        updated_at: organizations.updated_at,
        microdollars_used: organizations.microdollars_used,
        total_microdollars_acquired: organizations.total_microdollars_acquired,
        next_credit_expiration_at: organizations.next_credit_expiration_at,
        stripe_customer_id: organizations.stripe_customer_id,
        auto_top_up_enabled: organizations.auto_top_up_enabled,
        settings: organizations.settings,
        // Counts kilocode_users.id rather than organization_memberships.id so
        // billing-manager seats and bot users (filtered out of the user-side
        // join) are excluded.
        member_count: count(kilocode_users.id).as('member_count'),
        seat_count: organizations.seat_count,
        require_seats: organizations.require_seats,
        created_by_kilo_user_id: organizations.created_by_kilo_user_id,
        deleted_at: organizations.deleted_at,
        sso_domain: organizations.sso_domain,
        plan: organizations.plan,
        free_trial_end_at: organizations.free_trial_end_at,
        company_domain: organizations.company_domain,
        // Null out subscription_amount_usd for non-billable statuses so the
        // "Subscription" column doesn't display the dollar amount of a churned
        // plan as if it were current MRR. Reading "latest_stripe_status" tells
        // admins the lifecycle state separately. Cast to float8 so the JSON
        // payload matches the column's `mode: 'number'` declaration.
        subscription_amount_usd: sql<
          number | null
        >`CASE WHEN ${latestSubscriptions.subscription_status} IN ('active','trialing','past_due') THEN ${latestSubscriptions.amount_usd}::float8 ELSE NULL END`.as(
          'subscription_amount_usd'
        ),
        latest_stripe_status: latestSubscriptions.subscription_status,
        kilo_pass_tier: sortsByKiloPassTier
          ? organizationKiloPassTiers.kilo_pass_tier
          : sql<string | null>`NULL`.as('kilo_pass_tier'),
        kiloclaw_count:
          sql<number>`(SELECT COUNT(*) FROM kiloclaw_instances ki WHERE ki.organization_id = ${organizations.id} AND ki.destroyed_at IS NULL)::int`.as(
            'kiloclaw_count'
          ),
        has_github_integration: hasPlatformIntegrationSql('github', organizations.id).as(
          'has_github_integration'
        ),
        has_gitlab_integration: hasPlatformIntegrationSql('gitlab', organizations.id).as(
          'has_gitlab_integration'
        ),
        has_slack_integration: hasPlatformIntegrationSql('slack', organizations.id).as(
          'has_slack_integration'
        ),
        has_sso_configured: sql<boolean>`${organizations.sso_domain} IS NOT NULL`.as(
          'has_sso_configured'
        ),
        has_provider_controls:
          sql<boolean>`(${organizations.settings} -> 'provider_allow_list' IS NOT NULL OR ${organizations.settings} -> 'model_deny_list' IS NOT NULL)`.as(
            'has_provider_controls'
          ),
        has_data_privacy:
          sql<boolean>`${organizations.settings} -> 'data_collection' IS NOT NULL`.as(
            'has_data_privacy'
          ),
      };

      // Build base query without status-specific joins.
      // The member_count we surface excludes billing-manager seats and bot
      // users, so the membership join filters role and the user join filters
      // is_bot. With LEFT JOINs and a `count(kilocode_users.id)` aggregate,
      // rows that don't match those filters drop out of the count without
      // dropping the org from the result set.
      const baseQueryWithCommonJoins = db
        .select(organizationFields)
        .from(organizations)
        .leftJoin(
          organization_memberships,
          and(
            eq(organizations.id, organization_memberships.organization_id),
            ne(organization_memberships.role, 'billing_manager')
          )
        )
        .leftJoin(
          kilocode_users,
          and(
            eq(kilocode_users.id, organization_memberships.kilo_user_id),
            eq(kilocode_users.is_bot, false)
          )
        )
        .leftJoin(
          latestSubscriptions,
          and(
            eq(organizations.id, latestSubscriptions.organization_id),
            eq(latestSubscriptions.row_num, 1)
          )
        );

      const baseQuery = sortsByKiloPassTier
        ? baseQueryWithCommonJoins.leftJoin(
            organizationKiloPassTiers,
            eq(organizations.id, organizationKiloPassTiers.organization_id)
          )
        : baseQueryWithCommonJoins;

      // Add mode-based and stripe_status conditions
      const statusConditions = whereCondition ? [whereCondition] : [];

      if (mode === 'paying') {
        // Paying: has at least one seats purchase record (active or churned customers)
        statusConditions.push(
          sql`EXISTS (
            SELECT 1 FROM ${organization_seats_purchases}
            WHERE ${organization_seats_purchases.organization_id} = ${organizations.id}
          )`
        );
      } else if (mode === 'trial') {
        // Trial: has never had a seats purchase
        statusConditions.push(
          sql`NOT EXISTS (
            SELECT 1 FROM ${organization_seats_purchases}
            WHERE ${organization_seats_purchases.organization_id} = ${organizations.id}
          )`
        );
      }
      // mode === 'all': no subscription filter

      // Filter by Stripe subscription status (latest subscription for this org)
      if (stripe_status) {
        statusConditions.push(sql`${latestSubscriptions.subscription_status} = ${stripe_status}`);
      }

      const finalWhereCondition =
        statusConditions.length > 0 ? and(...statusConditions) : undefined;

      // Trial-tab "users > 1" filter is on the aggregate member_count, so it
      // has to go in HAVING (not WHERE). Same exclusions as the displayed
      // count: billing-manager seats and bot users do not count toward the
      // "more than one user" threshold.
      const havingCondition = has_multiple_users ? gt(count(kilocode_users.id), 1) : undefined;

      // Execute main query with pagination
      const filteredOrganizations = await baseQuery
        .where(finalWhereCondition)
        .groupBy(
          organizations.id,
          latestSubscriptions.amount_usd,
          latestSubscriptions.subscription_status,
          ...(sortsByKiloPassTier ? [organizationKiloPassTiers.kilo_pass_tier] : [])
        )
        .having(havingCondition)
        .orderBy(orderCondition)
        .limit(limit)
        .offset((page - 1) * limit);

      const organizationsWithKiloPassTiers = sortsByKiloPassTier
        ? filteredOrganizations
        : await (async () => {
            const organizationIds = filteredOrganizations.map(organization => organization.id);

            if (organizationIds.length === 0) {
              return filteredOrganizations;
            }

            const tierRows = await db
              .select({
                organization_id: organization_memberships.organization_id,
                kilo_pass_tier: sql<string | null>`MIN(${kilo_pass_subscriptions.tier})`.as(
                  'kilo_pass_tier'
                ),
              })
              .from(organization_memberships)
              .innerJoin(
                kilo_pass_subscriptions,
                eq(kilo_pass_subscriptions.kilo_user_id, organization_memberships.kilo_user_id)
              )
              .where(
                and(
                  eq(kilo_pass_subscriptions.status, 'active'),
                  inArray(organization_memberships.organization_id, organizationIds)
                )
              )
              .groupBy(organization_memberships.organization_id);

            const kiloPassTierByOrganizationId = new Map(
              tierRows.map(row => [row.organization_id, row.kilo_pass_tier])
            );

            return filteredOrganizations.map(organization => ({
              ...organization,
              kilo_pass_tier: kiloPassTierByOrganizationId.get(organization.id) ?? null,
            }));
          })();

      let totalOrganizationCount: number;

      if (has_multiple_users) {
        // Mirror the membership + user joins from baseQuery only when the
        // has_multiple_users HAVING clause needs the excluded member count.
        const countBase = db
          .select({ count: count() })
          .from(organizations)
          .leftJoin(
            organization_memberships,
            and(
              eq(organizations.id, organization_memberships.organization_id),
              ne(organization_memberships.role, 'billing_manager')
            )
          )
          .leftJoin(
            kilocode_users,
            and(
              eq(kilocode_users.id, organization_memberships.kilo_user_id),
              eq(kilocode_users.is_bot, false)
            )
          );

        const countQuery = stripe_status
          ? countBase
              .leftJoin(
                latestSubscriptions,
                and(
                  eq(organizations.id, latestSubscriptions.organization_id),
                  eq(latestSubscriptions.row_num, 1)
                )
              )
              .where(finalWhereCondition)
              .groupBy(organizations.id)
              .having(havingCondition)
          : countBase.where(finalWhereCondition).groupBy(organizations.id).having(havingCondition);

        totalOrganizationCount = (await countQuery).length;
      } else {
        const countBase = db.select({ count: count() }).from(organizations);

        const countQuery = stripe_status
          ? countBase
              .leftJoin(
                latestSubscriptions,
                and(
                  eq(organizations.id, latestSubscriptions.organization_id),
                  eq(latestSubscriptions.row_num, 1)
                )
              )
              .where(finalWhereCondition)
          : countBase.where(finalWhereCondition);

        const [countResult] = await countQuery;
        totalOrganizationCount = countResult?.count ?? 0;
      }

      const totalPages = Math.ceil(totalOrganizationCount / limit);

      return {
        organizations: organizationsWithKiloPassTiers,
        pagination: {
          page,
          limit,
          total: totalOrganizationCount,
          totalPages,
        },
      };
    }),

  search: adminProcedure
    .input(OrganizationSearchInputSchema)
    .output(z.array(OrganizationSearchResultSchema))
    .query(async ({ input }) => {
      const { search, limit } = input;
      const searchTerm = search.trim();

      if (!searchTerm) {
        return [];
      }

      const searchConditions = [ilike(organizations.name, `%${searchTerm}%`)];

      if (isValidUUID(searchTerm)) {
        searchConditions.push(eq(organizations.id, searchTerm));
      }

      const results = await db
        .select({
          id: organizations.id,
          name: organizations.name,
        })
        .from(organizations)
        .where(and(or(...searchConditions), isNull(organizations.deleted_at)))
        .orderBy(asc(organizations.name))
        .limit(limit);

      return results;
    }),
});

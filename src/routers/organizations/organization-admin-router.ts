import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  organizations,
  organization_memberships,
  kilocode_users,
  organization_seats_purchases,
  credit_transactions,
} from '@/db/schema';
import { ilike, or, asc, desc, count, eq, and, gt, isNull, isNotNull, sql } from 'drizzle-orm';
import * as z from 'zod';
import { OrganizationsApiGetResponseSchema } from '@/types/admin';
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

const OrganizationListInputSchema = z.object({
  page: z.number().int().min(1).default(1),
  limit: z.number().int().min(1).max(100_000).default(25),
  sortBy: z
    .enum(['name', 'created_at', 'microdollars_used', 'microdollars_balance', 'member_count'])
    .default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional().default(''),
  seatsRequired: z.enum(['true', 'false', '']).optional(),
  hasBalance: z.enum(['true', 'false', '']).optional(),
  status: z.enum(['active', 'deleted', 'incomplete', 'all']).default('active'),
  plan: z.enum(['enterprise', 'teams', '']).optional(),
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
  microdollars_balance: z.number(),
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
  teamCount: z.number(),
  teamMemberCount: z.number(),
  enterpriseCount: z.number(),
  enterpriseMemberCount: z.number(),
  trialingTeamCount: z.number(),
  trialingTeamMemberCount: z.number(),
  trialingEnterpriseCount: z.number(),
  trialingEnterpriseMemberCount: z.number(),
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
          microdollars_balance: organizations.microdollars_balance,
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
      const credit_expiry_date =
        explicit_expiry_date && expiryFromHours
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
            microdollars_balance: sql`${organizations.microdollars_balance} + ${amountMicrodollars}`,
            total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} + ${amountMicrodollars}`,
            ...(credit_expiry_date && {
              next_credit_expiration_at: sql`COALESCE(LEAST(${organizations.next_credit_expiration_at}, ${credit_expiry_date.toISOString()}), ${credit_expiry_date.toISOString()})`,
            }),
          })
          .where(eq(organizations.id, organizationId));
      });

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
            microdollars_balance: 0,
            total_microdollars_acquired: sql`${organizations.microdollars_used}`,
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
    // Get team metrics (organizations with plan = team AND active subscription)
    const teamMetrics = await db
      .select({
        orgCount: count(sql`DISTINCT ${organizations.id}`),
        memberCount: count(organization_memberships.id),
      })
      .from(organizations)
      .leftJoin(
        organization_memberships,
        eq(organizations.id, organization_memberships.organization_id)
      )
      .where(
        and(
          eq(organizations.plan, 'teams'),
          isNull(organizations.deleted_at),
          sql`EXISTS (
            SELECT 1 FROM ${organization_seats_purchases}
            WHERE ${organization_seats_purchases.organization_id} = ${organizations.id}
            AND ${organization_seats_purchases.subscription_status} = 'active'
          )`
        )
      );

    // Get enterprise metrics (organizations with require_seats = false)
    const enterpriseMetrics = await db
      .select({
        orgCount: count(sql`DISTINCT ${organizations.id}`),
        memberCount: count(organization_memberships.id),
      })
      .from(organizations)
      .leftJoin(
        organization_memberships,
        eq(organizations.id, organization_memberships.organization_id)
      )
      .where(and(eq(organizations.plan, 'enterprise'), isNull(organizations.deleted_at)));

    // Get trialing team metrics
    // (plan = 'teams', created within 30 days, has members, no seats purchase)
    const trialingTeamMetrics = await db
      .select({
        orgCount: count(sql`DISTINCT ${organizations.id}`),
        memberCount: count(organization_memberships.id),
      })
      .from(organizations)
      .innerJoin(
        organization_memberships,
        eq(organizations.id, organization_memberships.organization_id)
      )
      .where(
        and(
          eq(organizations.plan, 'teams'),
          isNull(organizations.deleted_at),
          sql`NOT EXISTS (
            SELECT 1 FROM ${organization_seats_purchases}
            WHERE ${organization_seats_purchases.organization_id} = ${organizations.id}
          )`
        )
      );

    // Get trialing enterprise metrics
    // (plan = 'enterprise', created within 30 days, has members, no seats purchase)
    const trialingEnterpriseMetrics = await db
      .select({
        orgCount: count(sql`DISTINCT ${organizations.id}`),
        memberCount: count(organization_memberships.id),
      })
      .from(organizations)
      .innerJoin(
        organization_memberships,
        eq(organizations.id, organization_memberships.organization_id)
      )
      .where(
        and(
          eq(organizations.plan, 'enterprise'),
          isNull(organizations.deleted_at),
          sql`NOT EXISTS (
            SELECT 1 FROM ${organization_seats_purchases}
            WHERE ${organization_seats_purchases.organization_id} = ${organizations.id}
          )`
        )
      );

    return {
      teamCount: teamMetrics[0]?.orgCount ?? 0,
      teamMemberCount: teamMetrics[0]?.memberCount ?? 0,
      enterpriseCount: enterpriseMetrics[0]?.orgCount ?? 0,
      enterpriseMemberCount: enterpriseMetrics[0]?.memberCount ?? 0,
      trialingTeamCount: trialingTeamMetrics[0]?.orgCount ?? 0,
      trialingTeamMemberCount: trialingTeamMetrics[0]?.memberCount ?? 0,
      trialingEnterpriseCount: trialingEnterpriseMetrics[0]?.orgCount ?? 0,
      trialingEnterpriseMemberCount: trialingEnterpriseMetrics[0]?.memberCount ?? 0,
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

    await markOrganizationAsDeleted(organizationId);

    return successResult();
  }),

  list: adminProcedure
    .input(OrganizationListInputSchema)
    .output(OrganizationsApiGetResponseSchema)
    .query(async ({ input }) => {
      const { page, limit, sortBy, sortOrder, search, seatsRequired, hasBalance, status, plan } =
        input;

      const searchTerm = search.trim();
      const sortField = sortBy;

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

      if (seatsRequired === 'true') {
        conditions.push(eq(organizations.require_seats, true));
      } else if (seatsRequired === 'false') {
        conditions.push(eq(organizations.require_seats, false));
      }

      if (hasBalance === 'true') {
        conditions.push(gt(organizations.microdollars_balance, 0));
      } else if (hasBalance === 'false') {
        conditions.push(eq(organizations.microdollars_balance, 0));
      }

      if (plan === 'enterprise') {
        conditions.push(eq(organizations.plan, 'enterprise'));
      } else if (plan === 'teams') {
        conditions.push(eq(organizations.plan, 'teams'));
      }

      // Handle status-based filtering
      if (status === 'deleted') {
        conditions.push(isNotNull(organizations.deleted_at));
      } else if (status === 'incomplete') {
        // For incomplete: require_seats = true, not deleted (subscription check done later)
        conditions.push(eq(organizations.require_seats, true));
        conditions.push(isNull(organizations.deleted_at));
      } else if (status === 'active') {
        // For active: not deleted (subscription check done later)
        conditions.push(isNull(organizations.deleted_at));
      } else if (status === 'all') {
        // For all: no deleted_at filter - show both active and deleted
        // Don't add any deleted_at condition
      } else {
        // Default to active if no status specified
        conditions.push(isNull(organizations.deleted_at));
      }

      const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

      let orderCondition;
      if (sortField === 'member_count') {
        const orderFunction = sortOrder === 'asc' ? asc : desc;
        orderCondition = orderFunction(count(organization_memberships.id));
      } else {
        const orderFunction = sortOrder === 'asc' ? asc : desc;
        orderCondition = orderFunction(organizations[sortField]);
      }

      // Subquery to get the latest active subscription per organization
      const latestSubscriptions = db
        .select({
          organization_id: organization_seats_purchases.organization_id,
          amount_usd: organization_seats_purchases.amount_usd,
          row_num:
            sql<number>`ROW_NUMBER() OVER (PARTITION BY ${organization_seats_purchases.organization_id} ORDER BY ${organization_seats_purchases.created_at} DESC)`.as(
              'row_num'
            ),
        })
        .from(organization_seats_purchases)
        .where(eq(organization_seats_purchases.subscription_status, 'active'))
        .as('latest_subscriptions');

      const organizationFields = {
        id: organizations.id,
        name: organizations.name,
        created_at: organizations.created_at,
        updated_at: organizations.updated_at,
        microdollars_balance: organizations.microdollars_balance,
        microdollars_used: organizations.microdollars_used,
        total_microdollars_acquired: organizations.total_microdollars_acquired,
        next_credit_expiration_at: organizations.next_credit_expiration_at,
        stripe_customer_id: organizations.stripe_customer_id,
        auto_top_up_enabled: organizations.auto_top_up_enabled,
        settings: organizations.settings,
        member_count: count(organization_memberships.id).as('member_count'),
        seat_count: organizations.seat_count,
        require_seats: organizations.require_seats,
        created_by_kilo_user_id: organizations.created_by_kilo_user_id,
        created_by_user_email: kilocode_users.google_user_email,
        created_by_user_name: kilocode_users.google_user_name,
        deleted_at: organizations.deleted_at,
        sso_domain: organizations.sso_domain,
        plan: organizations.plan,
        free_trial_end_at: organizations.free_trial_end_at,
        subscription_amount_usd: latestSubscriptions.amount_usd,
      };

      // Build base query without status-specific joins
      const baseQuery = db
        .select(organizationFields)
        .from(organizations)
        .leftJoin(
          organization_memberships,
          eq(organizations.id, organization_memberships.organization_id)
        )
        .leftJoin(kilocode_users, eq(organizations.created_by_kilo_user_id, kilocode_users.id))
        .leftJoin(
          latestSubscriptions,
          and(
            eq(organizations.id, latestSubscriptions.organization_id),
            eq(latestSubscriptions.row_num, 1)
          )
        );

      // Add status-specific conditions using subqueries
      const statusConditions = whereCondition ? [whereCondition] : [];

      if (status === 'incomplete') {
        // Incomplete: require_seats = true AND no active subscription
        statusConditions.push(eq(organizations.require_seats, true));
        statusConditions.push(
          sql`NOT EXISTS (
            SELECT 1 FROM ${organization_seats_purchases}
            WHERE ${organization_seats_purchases.organization_id} = ${organizations.id}
            AND ${organization_seats_purchases.subscription_status} = 'active'
          )`
        );
      } else if (status === 'active' || !status) {
        // Active: require_seats = false OR has active subscription
        statusConditions.push(
          sql`(
            ${organizations.require_seats} = false OR
            EXISTS (
              SELECT 1 FROM ${organization_seats_purchases}
              WHERE ${organization_seats_purchases.organization_id} = ${organizations.id}
              AND ${organization_seats_purchases.subscription_status} = 'active'
            )
          )`
        );
      } else if (status === 'all') {
        // All: no additional subscription-based filtering
        // Don't add any subscription conditions
      }

      const finalWhereCondition =
        statusConditions.length > 0 ? and(...statusConditions) : undefined;

      // Execute main query with pagination
      const filteredOrganizations = await baseQuery
        .where(finalWhereCondition)
        .groupBy(organizations.id, kilocode_users.id, latestSubscriptions.amount_usd)
        .orderBy(orderCondition)
        .limit(limit)
        .offset((page - 1) * limit);

      // Get total count using the same filtering logic
      const countQuery = db
        .select({ count: count() })
        .from(organizations)
        .leftJoin(
          organization_memberships,
          eq(organizations.id, organization_memberships.organization_id)
        )
        .where(finalWhereCondition)
        .groupBy(organizations.id);

      const totalCountResult = await countQuery;
      const totalOrganizationCount = totalCountResult.length;

      const totalPages = Math.ceil(totalOrganizationCount / limit);

      return {
        organizations: filteredOrganizations,
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

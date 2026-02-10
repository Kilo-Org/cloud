import { microdollar_usage, organization_seats_purchases, organizations } from '@/db/schema';
import { db } from '@/lib/drizzle';
import { captureMessage } from '@sentry/nextjs';
import type { OrganizationWithMembers } from '@/lib/organizations/organization-types';
import {
  OrganizationNameSchema,
  UsageStatsSchema,
  TimePeriodSchema,
  OrganizationCreateRequestSchema,
  OrganizationPlanSchema,
} from '@/lib/organizations/organization-types';
import {
  createOrganization,
  getOrganizationById,
  getOrganizationMembers,
  getUserOrganizationsWithSeats,
} from '@/lib/organizations/organizations';
import { getOrCreateStripeCustomerIdForOrganization } from '@/lib/organizations/organization-billing';
import { getStripeInvoices } from '@/lib/stripe';
import { adminProcedure, baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  OrganizationIdInputSchema,
  ensureOrganizationAccess,
  organizationMemberProcedure,
  organizationOwnerProcedure,
} from '@/routers/organizations/utils';
import { organizationsMembersRouter } from '@/routers/organizations/organization-members-router';
import { organizationsSubscriptionRouter } from '@/routers/organizations/organization-subscription-router';
import { organizationsSettingsRouter } from '@/routers/organizations/organization-settings-router';
import { organizationsUsageDetailsRouter } from '@/routers/organizations/organization-usage-details-router';
import { TRPCError } from '@trpc/server';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import * as z from 'zod';
import { getCreditTransactionsForOrganization } from '@/lib/creditTransactions';
import { getOrganizationSeatUsage } from '@/lib/organizations/organization-seats';
import { organizationSsoRouter } from '@/routers/organizations/organization-sso-router';
import { organizationAuditLogRouter } from '@/routers/organizations/organization-audit-log-router';
import { organizationAdminRouter } from '@/routers/organizations/organization-admin-router';
import { organizationModesRouter } from '@/routers/organizations/organization-modes-router';
import { createAuditLog } from '@/lib/organizations/organization-audit-logs';
import { organizationGitHubAppsRouter } from '@/routers/organizations/organization-github-apps-router';
import { organizationDeploymentsRouter } from '@/routers/organizations/organization-deployments-router';
import PostHogClient from '@/lib/posthog';
import { organizationReviewAgentRouter } from '@/routers/organizations/organization-code-reviews-router';
import { organizationCloudAgentRouter } from '@/routers/organizations/organization-cloud-agent-router';
import { organizationCloudAgentNextRouter } from '@/routers/organizations/organization-cloud-agent-next-router';
import { organizationAppBuilderRouter } from '@/routers/organizations/organization-app-builder-router';
import { organizationSecurityAgentRouter } from '@/routers/organizations/organization-security-agent-router';
import { organizationSlackRouter } from '@/routers/organizations/organization-slack-router';
import { organizationAutoTriageRouter } from '@/routers/organizations/organization-auto-triage-router';
import { organizationAutoFixRouter } from '@/routers/organizations/organization-auto-fix-router';
import { organizationAutoTopUpRouter } from '@/routers/organizations/organization-auto-top-up-router';

const OrganizationUpdateSchema = OrganizationIdInputSchema.extend({
  name: OrganizationNameSchema,
});

const OrganizationSeatsUpdateSchema = OrganizationIdInputSchema.extend({
  seatsRequired: z.boolean(),
});

const OrganizationInvoicesInputSchema = OrganizationIdInputSchema.extend({
  period: TimePeriodSchema.optional().default('month'),
});

function daysAgo(days: number): Date {
  const now = new Date();
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

const MAX_ORGANIZATIONS_PER_USER = 5;

function getDateThreshold(period: string): Date | null {
  switch (period) {
    case 'week':
      return daysAgo(7);
    case 'month':
      return daysAgo(30);
    case 'year':
      return daysAgo(365);
    case 'all':
      return null; // No date filtering for "all"
    default:
      return daysAgo(365); // Default to year
  }
}

export const organizationsRouter = createTRPCRouter({
  members: organizationsMembersRouter,
  subscription: organizationsSubscriptionRouter,
  settings: organizationsSettingsRouter,
  usageDetails: organizationsUsageDetailsRouter,
  sso: organizationSsoRouter,
  auditLogs: organizationAuditLogRouter,
  admin: organizationAdminRouter,
  modes: organizationModesRouter,
  githubApps: organizationGitHubAppsRouter,
  deployments: organizationDeploymentsRouter,
  reviewAgent: organizationReviewAgentRouter,
  cloudAgent: organizationCloudAgentRouter,
  cloudAgentNext: organizationCloudAgentNextRouter,
  appBuilder: organizationAppBuilderRouter,
  securityAgent: organizationSecurityAgentRouter,
  slack: organizationSlackRouter,
  autoTriage: organizationAutoTriageRouter,
  autoFix: organizationAutoFixRouter,
  autoTopUp: organizationAutoTopUpRouter,

  list: baseProcedure.query(async opts => {
    const { user } = opts.ctx;
    return await getUserOrganizationsWithSeats(user.id);
  }),

  create: baseProcedure.input(OrganizationCreateRequestSchema).mutation(async opts => {
    const { user } = opts.ctx;
    const existingOrgMemberships = await getUserOrganizationsWithSeats(user.id);

    if (
      existingOrgMemberships.length >= MAX_ORGANIZATIONS_PER_USER &&
      !user.google_user_email.endsWith('kilocode.ai')
    ) {
      captureMessage('User hit max organizations', {
        level: 'warning',
        extra: {
          userId: user.id,
          existingOrgMemberships: existingOrgMemberships.length,
          max: MAX_ORGANIZATIONS_PER_USER,
        },
      });
      throw new TRPCError({
        code: 'TOO_MANY_REQUESTS',
        message: `You have reached the maximum number of organizations (${MAX_ORGANIZATIONS_PER_USER}) allowed. Please contact support if you need more.`,
      });
    }
    const org = await createOrganization(opts.input.name, user.id, opts.input.autoAddCreator);
    await getOrCreateStripeCustomerIdForOrganization(org.id);

    const hog = PostHogClient();
    hog.capture({
      event: 'start_free_trial',
      distinctId: user.google_user_email,
      properties: {
        organizationId: org.id,
        product: opts.input.plan,
      },
    });

    await createAuditLog({
      organization_id: org.id,
      action: 'organization.created',
      actor_name: user.google_user_name,
      actor_email: user.google_user_email,
      actor_id: user.id,
      message: `Organization ${org.name} created`,
    });

    if (opts.input.plan === 'enterprise') {
      await db
        .update(organizations)
        .set({ plan: 'enterprise' })
        .where(eq(organizations.id, org.id));
    }

    return { organization: org };
  }),

  withMembers: organizationMemberProcedure.query<OrganizationWithMembers>(async opts => {
    const organizationId = opts.input.organizationId;

    const organization = await getOrganizationById(organizationId);

    if (!organization) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
      });
    }
    const members = await getOrganizationMembers(organizationId);

    return {
      ...organization,
      members,
    };
  }),

  update: organizationOwnerProcedure.input(OrganizationUpdateSchema).mutation(async opts => {
    await db
      .update(organizations)
      .set({ name: opts.input.name })
      .where(eq(organizations.id, opts.input.organizationId));
    return {
      organization: {
        id: opts.input.organizationId,
        name: opts.input.name,
      },
    };
  }),

  // this is an admin only proceedure until we do https://github.com/Kilo-Org/kilocode-backend/issues/2846
  updatePlan: adminProcedure
    .input(
      OrganizationIdInputSchema.extend({
        plan: OrganizationPlanSchema,
      })
    )
    .mutation(async opts => {
      await db
        .update(organizations)
        .set({ plan: opts.input.plan })
        .where(eq(organizations.id, opts.input.organizationId));
      return {
        organization: {
          id: opts.input.organizationId,
          plan: opts.input.plan,
        },
      };
    }),

  updateSeatsRequired: adminProcedure.input(OrganizationSeatsUpdateSchema).mutation(async opts => {
    await ensureOrganizationAccess(opts.ctx, opts.input.organizationId, ['owner']);
    await db
      .update(organizations)
      .set({ require_seats: opts.input.seatsRequired })
      .where(eq(organizations.id, opts.input.organizationId));
    return {
      organization: {
        id: opts.input.organizationId,
        require_seats: opts.input.seatsRequired,
      },
    };
  }),

  usageStats: organizationMemberProcedure.output(UsageStatsSchema).query(async opts => {
    // Fetch and return usage stats for the organization (last 30 days)
    // Get usage statistics
    const rows = await db
      .select({
        totalCost: sql<number>`COALESCE(SUM(${microdollar_usage.cost})::float, 0)`,
        totalRequestCount: count(microdollar_usage.id),
        totalInputTokens: sql<number>`COALESCE(SUM(${microdollar_usage.input_tokens})::float, 0)`,
        totalOutputTokens: sql<number>`COALESCE(SUM(${microdollar_usage.output_tokens})::float, 0)`,
      })
      .from(microdollar_usage)
      .where(
        and(
          eq(microdollar_usage.organization_id, opts.input.organizationId),
          sql`${microdollar_usage.created_at} >= NOW() - INTERVAL '30 days'`
        )
      );

    return rows[0];
  }),

  creditTransactions: organizationMemberProcedure.query(async opts => {
    return await getCreditTransactionsForOrganization(opts.input.organizationId);
  }),

  seats: organizationMemberProcedure.query(async opts => {
    const res = await getOrganizationSeatUsage(opts.input.organizationId);
    return {
      totalSeats: res.total,
      usedSeats: res.used,
    };
  }),

  // this is an admin only route used to show seat purchases in a debug UI for KILO admins
  seatPurchases: adminProcedure.input(OrganizationIdInputSchema).query(async opts => {
    await ensureOrganizationAccess(opts.ctx, opts.input.organizationId, ['owner']);
    const seatPurchases = await db
      .select()
      .from(organization_seats_purchases)
      .where(eq(organization_seats_purchases.organization_id, opts.input.organizationId))
      .orderBy(desc(organization_seats_purchases.created_at));
    return { seatPurchases };
  }),

  invoices: organizationOwnerProcedure.input(OrganizationInvoicesInputSchema).query(async opts => {
    const organization = await getOrganizationById(opts.input.organizationId);
    if (!organization) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Organization not found',
      });
    }

    const dateThreshold = getDateThreshold(opts.input.period);

    let stripeId = organization.stripe_customer_id;
    if (!stripeId) {
      stripeId = await getOrCreateStripeCustomerIdForOrganization(opts.input.organizationId);
    }

    const invoices = await getStripeInvoices(stripeId, dateThreshold);
    return invoices;
  }),
});

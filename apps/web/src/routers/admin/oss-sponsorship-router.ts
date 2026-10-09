import { adminProcedure, createTRPCRouter } from '@kilocode/web-shared/lib/trpc/init';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import {
  organizations,
  organization_invitations,
  organization_memberships,
  kilocode_users,
  cloud_agent_code_reviews,
  kiloclaw_instances,
} from '@kilocode/db/schema';
import type { User, Organization } from '@kilocode/db/schema';
import * as z from 'zod';
import { eq, isNull, and, or, ilike, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  sendOssInviteNewUserEmail,
  sendOssInviteExistingUserEmail,
  sendOssExistingOrgProvisionedEmail,
} from '@kilocode/web-shared/lib/email';
import { getAcceptInviteUrl } from '@kilocode/web-shared/lib/organizations/organizations';
import { grantEntityCreditForCategory } from '@kilocode/web-shared/lib/promotionalCredits';
import { TRPCError } from '@trpc/server';
import { getPrimaryGitHubIntegrationForOrganization } from '@/lib/integrations/db/platform-integrations';
import { getAgentConfig } from '@/lib/agent-config/db/agent-configs';

const OssCsvRowSchema = z.object({
  githubUrl: z.string().url(),
  email: z.string().email(),
  creditsDollars: z.number().nonnegative(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

function escapeIlikePattern(str: string): string {
  return str.replace(/[%_\\]/g, match => `\\${match}`);
}

function extractRepoNameFromUrl(githubUrl: string): string | null {
  try {
    const parsed = new URL(githubUrl);
    if (parsed.hostname !== 'github.com' && parsed.hostname !== 'www.github.com') {
      return null;
    }
    const pathParts = parsed.pathname.split('/').filter(Boolean);
    if (pathParts.length < 2) {
      return null;
    }
    const repoName = pathParts[1].replace(/\.git$/, '');
    return repoName || null;
  } catch {
    return null;
  }
}

const ProcessOssCsvInputSchema = z.array(OssCsvRowSchema);

type ProcessOssCsvResult = {
  email: string;
  orgId: string | null;
  success: boolean;
  error?: string;
};

async function processOssRow(
  adminUser: User,
  row: z.infer<typeof OssCsvRowSchema>
): Promise<ProcessOssCsvResult> {
  const { githubUrl, email, creditsDollars, tier } = row;
  const normalizedEmail = email.toLowerCase();

  try {
    const orgName = extractRepoNameFromUrl(githubUrl);
    if (!orgName) {
      return {
        email,
        orgId: null,
        success: false,
        error: 'Invalid GitHub URL - could not extract repository name',
      };
    }

    const [existingOssOrg] = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(
        and(
          eq(organizations.name, orgName),
          sql`${organizations.settings}->>'oss_sponsorship_tier' IS NOT NULL`,
          isNull(organizations.deleted_at)
        )
      )
      .limit(1);

    if (existingOssOrg) {
      return {
        email,
        orgId: null,
        success: false,
        error: `Organization "${orgName}" already exists in OSS program`,
      };
    }

    const [existingUser] = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.google_user_email, normalizedEmail))
      .limit(1);

    const now = new Date();
    const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    const creditsMicrodollars = creditsDollars > 0 ? creditsDollars * 1_000_000 : null;

    const result = await db.transaction(async (tx: DrizzleTransaction) => {
      const [organization] = await tx
        .insert(organizations)
        .values({
          name: orgName,
          plan: 'enterprise',
          require_seats: false,
          free_trial_end_at: oneYearFromNow.toISOString(),
          settings: {
            enable_usage_limits: false,
            code_indexing_enabled: true,
            suppress_trial_messaging: true,
            oss_sponsorship_tier: tier,
            oss_monthly_credit_amount_microdollars: creditsMicrodollars,
            oss_credits_last_reset_at: creditsMicrodollars ? now.toISOString() : null,
            oss_github_url: githubUrl,
          },
        })
        .returning();

      if (!organization) {
        throw new Error('Failed to create organization');
      }

      if (existingUser) {
        await tx.insert(organization_memberships).values({
          organization_id: organization.id,
          kilo_user_id: existingUser.id,
          role: 'owner',
          invited_by: adminUser.id,
        });

        // Send welcome email (not an invite - they're already added)
        await sendOssInviteExistingUserEmail({
          to: normalizedEmail,
          organizationName: orgName,
          organizationId: organization.id,
          tier,
          monthlyCreditsUsd: creditsDollars,
        });
      } else {
        const inviteToken = randomUUID();
        const inviteExpiry = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 1 year expiry for OSS invites

        await tx.insert(organization_invitations).values({
          organization_id: organization.id,
          email: normalizedEmail,
          role: 'owner',
          invited_by: adminUser.id,
          token: inviteToken,
          expires_at: inviteExpiry.toISOString(),
        });

        const acceptInviteUrl = getAcceptInviteUrl(inviteToken);
        await sendOssInviteNewUserEmail({
          to: normalizedEmail,
          organizationName: orgName,
          organizationId: organization.id,
          acceptInviteUrl,
          tier,
          monthlyCreditsUsd: creditsDollars,
        });
      }

      if (creditsDollars > 0) {
        const creditResult = await grantEntityCreditForCategory(
          { user: adminUser, organization: organization },
          {
            credit_category: 'oss-sponsorship',
            counts_as_selfservice: false,
            amount_usd: creditsDollars,
            description: `OSS Sponsorship Tier ${tier} initial credits`,
            dbOrTx: tx,
          }
        );

        if (!creditResult.success) {
          throw new Error(`Failed to grant credits: ${creditResult.message}`);
        }
      }

      return organization;
    });

    return { email, orgId: result.id, success: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { email, orgId: null, success: false, error: errorMessage };
  }
}

export const ossSponsorshipRouter = createTRPCRouter({
  processOssCsv: adminProcedure
    .input(ProcessOssCsvInputSchema)
    .mutation(async ({ input, ctx }): Promise<ProcessOssCsvResult[]> => {
      const results: ProcessOssCsvResult[] = [];

      for (const row of input) {
        const result = await processOssRow(ctx.user, row);
        results.push(result);
      }

      return results;
    }),

  listOssSponsorships: adminProcedure.query(async () => {
    const ossOrgs = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        settings: organizations.settings,
        total_microdollars_acquired: organizations.total_microdollars_acquired,
        microdollars_used: organizations.microdollars_used,
        created_at: organizations.created_at,
      })
      .from(organizations)
      .where(
        and(
          sql`${organizations.settings}->>'oss_sponsorship_tier' IS NOT NULL`,
          isNull(organizations.deleted_at)
        )
      );

    const results = await Promise.all(
      ossOrgs.map(async org => {
        let email: string | null = null;
        let hasKiloAccount = false;
        let kiloUserId: string | null = null;

        const [ownerInvitation] = await db
          .select({
            email: organization_invitations.email,
            accepted_at: organization_invitations.accepted_at,
          })
          .from(organization_invitations)
          .where(
            and(
              eq(organization_invitations.organization_id, org.id),
              eq(organization_invitations.role, 'owner')
            )
          )
          .limit(1);

        if (ownerInvitation) {
          email = ownerInvitation.email;
          const [user] = await db
            .select({ id: kilocode_users.id })
            .from(kilocode_users)
            .where(eq(kilocode_users.google_user_email, email))
            .limit(1);

          if (user) {
            hasKiloAccount = true;
            kiloUserId = user.id;
          }
        } else {
          const [ownerMembership] = await db
            .select({
              kilo_user_id: organization_memberships.kilo_user_id,
            })
            .from(organization_memberships)
            .where(
              and(
                eq(organization_memberships.organization_id, org.id),
                eq(organization_memberships.role, 'owner')
              )
            )
            .limit(1);

          if (ownerMembership?.kilo_user_id) {
            kiloUserId = ownerMembership.kilo_user_id;
            hasKiloAccount = true;

            const [user] = await db
              .select({ google_user_email: kilocode_users.google_user_email })
              .from(kilocode_users)
              .where(eq(kilocode_users.id, kiloUserId))
              .limit(1);

            email = user?.google_user_email || null;
          }
        }

        const monthlyCredits = org.settings.oss_monthly_credit_amount_microdollars;

        const githubIntegration = await getPrimaryGitHubIntegrationForOrganization(org.id);
        const hasGitHubIntegration = githubIntegration !== null;

        const codeReviewConfig = await getAgentConfig(org.id, 'code_review', 'github');
        const hasCodeReviewsEnabled = codeReviewConfig?.is_enabled === true;

        const isOnboardingComplete = hasGitHubIntegration && hasCodeReviewsEnabled;

        const [latestCodeReview] = await db
          .select({
            completed_at: cloud_agent_code_reviews.completed_at,
          })
          .from(cloud_agent_code_reviews)
          .where(
            and(
              eq(cloud_agent_code_reviews.owned_by_organization_id, org.id),
              eq(cloud_agent_code_reviews.status, 'completed')
            )
          )
          .orderBy(desc(cloud_agent_code_reviews.completed_at))
          .limit(1);

        const hasCompletedCodeReview = !!latestCodeReview;
        const lastCodeReviewDate = latestCodeReview?.completed_at ?? null;

        let hasKiloClawInstance = false;
        if (kiloUserId) {
          const [kiloclawInstance] = await db
            .select({ id: kiloclaw_instances.id })
            .from(kiloclaw_instances)
            .where(
              and(
                eq(kiloclaw_instances.user_id, kiloUserId),
                isNull(kiloclaw_instances.destroyed_at)
              )
            )
            .limit(1);
          hasKiloClawInstance = !!kiloclawInstance;
        }

        return {
          email,
          hasKiloAccount,
          kiloUserId,
          organizationId: org.id,
          organizationName: org.name,
          githubUrl: org.settings.oss_github_url ?? null,
          tier: org.settings.oss_sponsorship_tier ?? null,
          monthlyCreditsUsd: monthlyCredits ? monthlyCredits / 1_000_000 : null,
          lastResetAt: org.settings.oss_credits_last_reset_at ?? null,
          currentBalanceUsd: (org.total_microdollars_acquired - org.microdollars_used) / 1_000_000,
          createdAt: org.created_at,
          hasGitHubIntegration,
          hasCodeReviewsEnabled,
          isOnboardingComplete,
          hasCompletedCodeReview,
          lastCodeReviewDate,
          hasKiloClawInstance,
        };
      })
    );

    return results;
  }),

  searchOrganizations: adminProcedure
    .input(z.object({ query: z.string().min(1) }))
    .query(async ({ input }) => {
      const { query } = input;

      const results = await db
        .select({
          id: organizations.id,
          name: organizations.name,
          plan: organizations.plan,
          require_seats: organizations.require_seats,
          settings: organizations.settings,
        })
        .from(organizations)
        .where(
          and(
            isNull(organizations.deleted_at),
            sql`${organizations.settings}->>'oss_sponsorship_tier' IS NULL`,
            or(
              ilike(organizations.name, `%${escapeIlikePattern(query)}%`),
              eq(organizations.id, query)
            )
          )
        )
        .limit(20);

      return results.map(org => ({
        id: org.id,
        name: org.name,
        plan: org.plan,
        requireSeats: org.require_seats,
        suppressTrialMessaging: org.settings.suppress_trial_messaging ?? false,
      }));
    }),

  addExistingOrgToOss: adminProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
        monthlyTopUpDollars: z.number().nonnegative(),
        addInitialGrant: z.boolean(),
        sendEmail: z.boolean().default(false),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { organizationId, tier, monthlyTopUpDollars, addInitialGrant, sendEmail } = input;
      const creditsMicrodollars = monthlyTopUpDollars > 0 ? monthlyTopUpDollars * 1_000_000 : null;
      const now = new Date();

      const [existingOrg] = await db
        .select()
        .from(organizations)
        .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)));

      if (!existingOrg) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Organization not found',
        });
      }

      if (
        existingOrg.settings.oss_sponsorship_tier !== null &&
        existingOrg.settings.oss_sponsorship_tier !== undefined
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Organization is already in the OSS program',
        });
      }

      await db.transaction(async (tx: DrizzleTransaction) => {
        const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

        await tx
          .update(organizations)
          .set({
            plan: 'enterprise',
            require_seats: false,
            free_trial_end_at: oneYearFromNow.toISOString(),
            settings: {
              ...existingOrg.settings,
              suppress_trial_messaging: true,
              oss_sponsorship_tier: tier,
              oss_monthly_credit_amount_microdollars: creditsMicrodollars,
              oss_credits_last_reset_at: creditsMicrodollars ? now.toISOString() : null,
            },
          })
          .where(eq(organizations.id, organizationId));

        if (addInitialGrant && monthlyTopUpDollars > 0) {
          const creditResult = await grantEntityCreditForCategory(
            { user: ctx.user, organization: existingOrg as Organization },
            {
              credit_category: 'oss-sponsorship',
              counts_as_selfservice: false,
              amount_usd: monthlyTopUpDollars,
              description: `OSS Sponsorship Tier ${tier} initial credits (existing org enrollment)`,
              dbOrTx: tx,
            }
          );

          if (!creditResult.success) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: `Failed to grant credits: ${creditResult.message}`,
            });
          }
        }
      });

      if (sendEmail) {
        const ownerMemberships = await db
          .select({
            kilo_user_id: organization_memberships.kilo_user_id,
          })
          .from(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, organizationId),
              eq(organization_memberships.role, 'owner')
            )
          );

        const ownerEmails: string[] = [];
        for (const membership of ownerMemberships) {
          if (membership.kilo_user_id) {
            const [user] = await db
              .select({ email: kilocode_users.google_user_email })
              .from(kilocode_users)
              .where(eq(kilocode_users.id, membership.kilo_user_id))
              .limit(1);
            if (user?.email) {
              ownerEmails.push(user.email);
            }
          }
        }

        if (ownerEmails.length > 0) {
          await sendOssExistingOrgProvisionedEmail({
            to: ownerEmails,
            organizationName: existingOrg.name,
            organizationId,
            tier,
            monthlyCreditsUsd: monthlyTopUpDollars,
          });
        }
      }

      return {
        success: true,
        organizationId,
        tier,
        monthlyTopUpDollars,
        addInitialGrant,
        sendEmail,
      };
    }),
});

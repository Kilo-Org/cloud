import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db, sql } from '@/lib/drizzle';
import type { DrizzleTransaction } from '@/lib/drizzle';
import {
  organizations,
  organization_invitations,
  organization_memberships,
  kilocode_users,
  cloud_agent_code_reviews,
} from '@/db/schema';
import type { User, Organization } from '@/db/schema';
import * as z from 'zod';
import { eq, isNull, and, or, ilike, desc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import {
  sendOssInviteNewUserEmail,
  sendOssInviteExistingUserEmail,
  sendOssExistingOrgProvisionedEmail,
} from '@/lib/email';
import { getAcceptInviteUrl } from '@/lib/organizations/organizations';
import { grantEntityCreditForCategory } from '@/lib/promotionalCredits';
import { TRPCError } from '@trpc/server';
import { getIntegrationForOrganization } from '@/lib/integrations/db/platform-integrations';
import { getAgentConfig } from '@/lib/agent-config/db/agent-configs';

const OssCsvRowSchema = z.object({
  githubUrl: z.string().url(),
  email: z.string().email(),
  creditsDollars: z.number().nonnegative(),
  tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
});

/**
 * Escape special characters for PostgreSQL ILIKE pattern matching.
 * The % and _ characters have special meaning in ILIKE patterns.
 */
function escapeIlikePattern(str: string): string {
  return str.replace(/[%_\\]/g, match => `\\${match}`);
}

/**
 * Extract repository name from a GitHub URL.
 * Examples:
 * - https://github.com/owner/repo -> repo
 * - https://github.com/owner/repo.git -> repo
 */
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
    // Get repo name (second part of path), remove .git extension if present
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

/**
 * Process a single OSS sponsorship row with hybrid flow (Option A):
 * 1. Create organization with name = GitHub repository name
 * 2. Check if user with this email already exists in Kilo
 *    - If EXISTS: Directly add them to organization_memberships as Owner + send welcome email
 *    - If NOT EXISTS: Create invitation + send invite email (user must accept)
 * 3. Extend trial end date by 1 year from now
 * 4. Set require_seats to false
 * 5. Set suppress_trial_messaging to true
 * 6. Set oss_sponsorship_tier to the provided tier
 * 7. If creditsDollars > 0: grant credits using the standard credit granting function
 */
async function processOssRow(
  adminUser: User,
  row: z.infer<typeof OssCsvRowSchema>
): Promise<ProcessOssCsvResult> {
  const { githubUrl, email, creditsDollars, tier } = row;
  const normalizedEmail = email.toLowerCase();

  try {
    // Extract org name from GitHub repository URL
    const orgName = extractRepoNameFromUrl(githubUrl);
    if (!orgName) {
      return {
        email,
        orgId: null,
        success: false,
        error: 'Invalid GitHub URL - could not extract repository name',
      };
    }

    // Check if an OSS organization with this repo name already exists
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

    // Check if user with this email already exists in Kilo
    const [existingUser] = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.google_user_email, normalizedEmail))
      .limit(1);

    // Calculate values
    const now = new Date();
    const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
    const creditsMicrodollars = creditsDollars > 0 ? creditsDollars * 1_000_000 : null;

    const result = await db.transaction(async (tx: DrizzleTransaction) => {
      // 1. Create organization
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
        // User EXISTS: Directly add them to the organization as Owner
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
        // User does NOT exist: Create invitation for them to accept after signing up
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

        // Send invitation email
        const acceptInviteUrl = getAcceptInviteUrl(inviteToken);
        await sendOssInviteNewUserEmail({
          to: normalizedEmail,
          organizationName: orgName,
          organizationId: organization.id,
          acceptInviteUrl,
          inviteCode: inviteToken,
          tier,
          monthlyCreditsUsd: creditsDollars,
        });
      }

      // 3. If credits > 0, grant credits using the standard function
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
  /**
   * Process an array of OSS sponsorship CSV rows.
   * For each row, creates an organization, invites the user, and optionally grants credits.
   * Individual row failures don't fail the entire batch.
   */
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

  /**
   * List all OSS sponsorships (organizations with oss_sponsorship_tier set in settings).
   * Returns organization info along with invited owner's email and account status.
   *
   * Email lookup strategy:
   * 1. Check organization_invitations for owner role (used for new users invited via CSV)
   * 2. If no invitation, check organization_memberships for owner role and get their email
   *    (used for existing users directly added to org)
   */
  listOssSponsorships: adminProcedure.query(async () => {
    // Get all organizations with OSS sponsorship tier set in settings
    const ossOrgs = await db
      .select({
        id: organizations.id,
        name: organizations.name,
        settings: organizations.settings,
        microdollars_balance: organizations.microdollars_balance,
        created_at: organizations.created_at,
      })
      .from(organizations)
      .where(
        and(
          sql`${organizations.settings}->>'oss_sponsorship_tier' IS NOT NULL`,
          isNull(organizations.deleted_at)
        )
      );

    // For each org, find the owner email (from invitation or direct membership)
    const results = await Promise.all(
      ossOrgs.map(async org => {
        let email: string | null = null;
        let hasKiloAccount = false;
        let kiloUserId: string | null = null;

        // First, check for an owner invitation (for users invited via CSV who may not have signed up yet)
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
          // Check if user with this email exists
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
          // No invitation found - check for direct owner membership (existing user flow)
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

            // Look up the user's email
            const [user] = await db
              .select({ google_user_email: kilocode_users.google_user_email })
              .from(kilocode_users)
              .where(eq(kilocode_users.id, kiloUserId))
              .limit(1);

            email = user?.google_user_email || null;
          }
        }

        const monthlyCredits = org.settings.oss_monthly_credit_amount_microdollars;

        // Check GitHub integration status
        const githubIntegration = await getIntegrationForOrganization(org.id, 'github');
        const hasGitHubIntegration = githubIntegration?.integration_status === 'active';

        // Check Code Reviews configuration status
        const codeReviewConfig = await getAgentConfig(org.id, 'code_review', 'github');
        const hasCodeReviewsEnabled = codeReviewConfig?.is_enabled === true;

        // Onboarding is complete if both GitHub and Code Reviews are set up
        const isOnboardingComplete = hasGitHubIntegration && hasCodeReviewsEnabled;

        // Check for latest completed code review for this organization
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
          currentBalanceUsd: org.microdollars_balance / 1_000_000,
          createdAt: org.created_at,
          hasGitHubIntegration,
          hasCodeReviewsEnabled,
          isOnboardingComplete,
          hasCompletedCodeReview,
          lastCodeReviewDate,
        };
      })
    );

    return results;
  }),

  /**
   * Search for existing organizations by name or ID.
   * Returns organizations that are NOT already in the OSS program.
   */
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
            // Exclude orgs already in OSS program
            sql`${organizations.settings}->>'oss_sponsorship_tier' IS NULL`,
            // Search by name or ID (escape ILIKE special chars %, _, \)
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

  /**
   * Add an existing organization to the OSS program.
   * Sets the org to Enterprise plan, disables seat requirements, suppresses trial messaging,
   * and optionally grants initial credits. Always sets the monthly top-up amount.
   * Optionally sends an email to the organization's owners.
   */
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

      // Fetch the organization
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

      // Check if already in OSS program
      if (
        existingOrg.settings.oss_sponsorship_tier !== null &&
        existingOrg.settings.oss_sponsorship_tier !== undefined
      ) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Organization is already in the OSS program',
        });
      }

      // Update organization within a transaction
      await db.transaction(async (tx: DrizzleTransaction) => {
        // Calculate 1 year from now for trial extension
        const oneYearFromNow = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

        // Update the organization
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

        // Grant initial credits only if addInitialGrant is true and amount > 0
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

      // Send email to org owners if requested
      if (sendEmail) {
        // Get all owners of the organization
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

        // Get emails for all owners
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

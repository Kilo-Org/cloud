import { db } from '@/lib/drizzle';
import {
  agent_configs,
  kilocode_users,
  organization_invitations,
  organization_memberships,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { platformIntegrationHealthSql } from '@/lib/integrations/core/health';
import { and, count, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  OrganizationOnboardingStepKeySchema,
  type OrganizationOnboardingStepKey,
} from '@/lib/organizations/onboarding-steps';

export {
  ORGANIZATION_ONBOARDING_STEP_KEYS,
  OrganizationOnboardingStepKeySchema,
  type OrganizationOnboardingStepKey,
} from '@/lib/organizations/onboarding-steps';

export const SourceControlPlatformSchema = z.literal('github');

export const OrganizationOnboardingStateSchema = z.object({
  sourceControlConnected: z.boolean(),
  connectedPlatform: SourceControlPlatformSchema.nullable(),
  codeReviewerEnabled: z.boolean(),
  teamInvited: z.boolean(),
});
export type OrganizationOnboardingState = z.infer<typeof OrganizationOnboardingStateSchema>;

export const OrganizationOnboardingChecklistSchema = z.object({
  steps: z.array(
    z.object({
      key: OrganizationOnboardingStepKeySchema,
      done: z.boolean(),
    })
  ),
  completedCount: z.number().int().nonnegative(),
  totalCount: z.number().int().positive(),
  connectedPlatform: SourceControlPlatformSchema.nullable(),
});
export type OrganizationOnboardingChecklist = z.infer<typeof OrganizationOnboardingChecklistSchema>;

export function buildOrganizationOnboardingChecklist(
  state: OrganizationOnboardingState
): OrganizationOnboardingChecklist {
  const steps = [
    { key: 'source-control', done: state.sourceControlConnected },
    { key: 'code-reviewer', done: state.codeReviewerEnabled },
    { key: 'invite-team', done: state.teamInvited },
  ] satisfies Array<{ key: OrganizationOnboardingStepKey; done: boolean }>;

  return {
    steps,
    completedCount: steps.filter(step => step.done).length,
    totalCount: steps.length,
    connectedPlatform: state.connectedPlatform,
  };
}

/**
 * True when the organization has at least one healthy (active, non-suspended,
 * authenticated) GitHub platform integration. Guided onboarding only treats
 * GitHub as source-control completion.
 */
async function hasHealthyGitHubIntegration(organizationId: string): Promise<boolean> {
  const rows = await db
    .select({ id: platform_integrations.id })
    .from(platform_integrations)
    .where(
      and(
        eq(platform_integrations.owned_by_organization_id, organizationId),
        eq(platform_integrations.platform, PLATFORM.GITHUB),
        platformIntegrationHealthSql()
      )
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * True when the organization has an enabled GitHub Code Reviewer config backed
 * by a healthy GitHub integration.
 */
async function hasEnabledGitHubCodeReviewer(organizationId: string): Promise<boolean> {
  const rows = await db
    .select({ id: agent_configs.id })
    .from(agent_configs)
    .innerJoin(
      platform_integrations,
      and(
        eq(platform_integrations.owned_by_organization_id, organizationId),
        eq(platform_integrations.platform, agent_configs.platform),
        platformIntegrationHealthSql()
      )
    )
    .where(
      and(
        eq(agent_configs.owned_by_organization_id, organizationId),
        eq(agent_configs.agent_type, 'code_review'),
        eq(agent_configs.platform, PLATFORM.GITHUB),
        eq(agent_configs.is_enabled, true)
      )
    )
    .limit(1);

  return rows.length > 0;
}

/** True when the organization has an unaccepted, unexpired invitation. */
async function hasPendingInvitation(organizationId: string): Promise<boolean> {
  const rows = await db
    .select({ id: organization_invitations.id })
    .from(organization_invitations)
    .where(
      and(
        eq(organization_invitations.organization_id, organizationId),
        isNull(organization_invitations.accepted_at),
        gt(organization_invitations.expires_at, sql`NOW()`)
      )
    )
    .limit(1);

  return rows.length > 0;
}

/** Number of human (non-bot) members in the organization. */
async function countHumanMembers(organizationId: string): Promise<number> {
  const [row] = await db
    .select({ humanMemberCount: count() })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(kilocode_users.is_bot, false)
      )
    );

  return row?.humanMemberCount ?? 0;
}

/** True when a human member other than the creator has joined. */
async function hasHumanMemberOtherThanCreator(
  organizationId: string,
  creatorKiloUserId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: organization_memberships.id })
    .from(organization_memberships)
    .innerJoin(kilocode_users, eq(kilocode_users.id, organization_memberships.kilo_user_id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(kilocode_users.is_bot, false),
        ne(organization_memberships.kilo_user_id, creatorKiloUserId)
      )
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * The team step is satisfied by a pending invitation, or by a second human
 * having joined. When the creator is known we only need one human besides them;
 * when the creator is unknown we require at least two humans overall.
 *
 * The invitation and membership checks are independent, so we run them
 * concurrently to keep this off the critical path of a single round-trip.
 */
async function hasInvitedTeam(organization: {
  id: string;
  createdByKiloUserId: string | null;
}): Promise<boolean> {
  const { id, createdByKiloUserId } = organization;
  const [pendingInvitation, hasQualifyingMembers] = await Promise.all([
    hasPendingInvitation(id),
    createdByKiloUserId !== null
      ? hasHumanMemberOtherThanCreator(id, createdByKiloUserId)
      : countHumanMembers(id).then(humanMemberCount => humanMemberCount >= 2),
  ]);

  return pendingInvitation || hasQualifyingMembers;
}

export async function getOrganizationOnboardingState(
  organizationId: string
): Promise<OrganizationOnboardingState> {
  const [organization] = await db
    .select({
      id: organizations.id,
      createdByKiloUserId: organizations.created_by_kilo_user_id,
    })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
    .limit(1);

  if (!organization) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Organization not found',
    });
  }

  const [sourceControlConnected, codeReviewerEnabled, teamInvited] = await Promise.all([
    hasHealthyGitHubIntegration(organizationId),
    hasEnabledGitHubCodeReviewer(organizationId),
    hasInvitedTeam(organization),
  ]);

  return OrganizationOnboardingStateSchema.parse({
    sourceControlConnected,
    connectedPlatform: sourceControlConnected ? PLATFORM.GITHUB : null,
    codeReviewerEnabled,
    teamInvited,
  });
}

import { db } from '@/lib/drizzle';
import { INTEGRATION_STATUS, PLATFORM } from '@/lib/integrations/core/constants';
import { sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';

export const ORGANIZATION_ONBOARDING_STEP_KEYS = [
  'source-control',
  'code-reviewer',
  'invite-team',
] as const;

export const OrganizationOnboardingStepKeySchema = z.enum(ORGANIZATION_ONBOARDING_STEP_KEYS);
export type OrganizationOnboardingStepKey = z.infer<typeof OrganizationOnboardingStepKeySchema>;

export const SourceControlPlatformSchema = z.enum(['github', 'gitlab']);
export type SourceControlPlatform = z.infer<typeof SourceControlPlatformSchema>;

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

export async function getOrganizationOnboardingState(
  organizationId: string
): Promise<OrganizationOnboardingState> {
  const result = await db.execute(sql`
    SELECT
      EXISTS (
        SELECT 1
        FROM platform_integrations
        WHERE owned_by_organization_id = organizations.id
          AND platform IN (${PLATFORM.GITHUB}, ${PLATFORM.GITLAB})
          AND integration_status = ${INTEGRATION_STATUS.ACTIVE}
          AND suspended_at IS NULL
          AND auth_invalid_at IS NULL
      ) AS "sourceControlConnected",
      (
        SELECT platform
        FROM platform_integrations
        WHERE owned_by_organization_id = organizations.id
          AND platform IN (${PLATFORM.GITHUB}, ${PLATFORM.GITLAB})
          AND integration_status = ${INTEGRATION_STATUS.ACTIVE}
          AND suspended_at IS NULL
          AND auth_invalid_at IS NULL
        ORDER BY CASE WHEN platform = ${PLATFORM.GITHUB} THEN 0 ELSE 1 END
        LIMIT 1
      ) AS "connectedPlatform",
      EXISTS (
        SELECT 1
        FROM agent_configs
        WHERE owned_by_organization_id = organizations.id
          AND agent_type = 'code_review'
          AND platform = (
            SELECT platform
            FROM platform_integrations
            WHERE owned_by_organization_id = organizations.id
              AND platform IN (${PLATFORM.GITHUB}, ${PLATFORM.GITLAB})
              AND integration_status = ${INTEGRATION_STATUS.ACTIVE}
              AND suspended_at IS NULL
              AND auth_invalid_at IS NULL
            ORDER BY CASE WHEN platform = ${PLATFORM.GITHUB} THEN 0 ELSE 1 END
            LIMIT 1
          )
          AND is_enabled = true
      ) AS "codeReviewerEnabled",
      (
        EXISTS (
          SELECT 1
          FROM organization_invitations
          WHERE organization_id = organizations.id
            AND accepted_at IS NULL
            AND expires_at > NOW()
        )
        OR EXISTS (
          SELECT 1
          FROM organization_memberships
          INNER JOIN kilocode_users
            ON kilocode_users.id = organization_memberships.kilo_user_id
          WHERE organization_memberships.organization_id = organizations.id
            AND kilocode_users.is_bot = false
            AND organizations.created_by_kilo_user_id IS NOT NULL
            AND organization_memberships.kilo_user_id <> organizations.created_by_kilo_user_id
        )
        OR (
          organizations.created_by_kilo_user_id IS NULL
          AND (
            SELECT COUNT(*)
            FROM organization_memberships
            INNER JOIN kilocode_users
              ON kilocode_users.id = organization_memberships.kilo_user_id
            WHERE organization_memberships.organization_id = organizations.id
              AND kilocode_users.is_bot = false
          ) >= 2
        )
      ) AS "teamInvited"
    FROM organizations
    WHERE organizations.id = ${organizationId}
      AND organizations.deleted_at IS NULL
    LIMIT 1
  `);

  const row = result.rows[0];
  if (!row) {
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'Organization not found',
    });
  }

  return OrganizationOnboardingStateSchema.parse(row);
}

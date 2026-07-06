import { organizations } from '@kilocode/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { readDb } from '@/lib/drizzle';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';

export const FEATURE_ADOPTION_KEYS = [
  'source-control-integration',
  'code-reviewer',
  'security-agent',
  'team-integration',
  'cloud-agent-used',
  'project-deployed',
] as const;

export type FeatureAdoptionKey = (typeof FEATURE_ADOPTION_KEYS)[number];

export type FeatureAdoptionCheck = {
  key: FeatureAdoptionKey;
  title: string;
  description: string;
  adopted: boolean;
  adoptedLabel: string;
  notAdoptedLabel: string;
  actionLabel: string;
  actionUrl: string;
};

export type FeatureAdoptionState = {
  sourceControlConnected: boolean;
  codeReviewerEnabled: boolean;
  securityAgentEnabled: boolean;
  teamIntegrationConnected: boolean;
  cloudAgentUsed: boolean;
  projectDeployed: boolean;
};

type FeatureAdoptionStateRow = {
  source_control_connected: boolean;
  code_reviewer_enabled: boolean;
  security_agent_enabled: boolean;
  team_integration_connected: boolean;
  cloud_agent_used: boolean;
  project_deployed: boolean;
};

export function buildFeatureAdoptionChecks(
  organizationId: string,
  state: FeatureAdoptionState
): FeatureAdoptionCheck[] {
  return [
    {
      key: 'source-control-integration',
      title: 'Source control connected',
      description:
        'Connect GitHub or GitLab to bring repositories and development workflows into Kilo.',
      adopted: state.sourceControlConnected,
      adoptedLabel: 'Connected',
      notAdoptedLabel: 'Not connected',
      actionLabel: state.sourceControlConnected ? 'Manage integrations' : 'Connect source control',
      actionUrl: `/organizations/${organizationId}/integrations`,
    },
    {
      key: 'code-reviewer',
      title: 'Code Reviewer enabled',
      description: 'Run AI assisted reviews on pull requests or merge requests.',
      adopted: state.codeReviewerEnabled,
      adoptedLabel: 'Enabled',
      notAdoptedLabel: 'Not enabled',
      actionLabel: state.codeReviewerEnabled ? 'Review settings' : 'Enable Code Reviewer',
      actionUrl: `/organizations/${organizationId}/code-reviews`,
    },
    {
      key: 'security-agent',
      title: 'Security Agent enabled',
      description: 'Monitor repositories for Security Findings and remediation opportunities.',
      adopted: state.securityAgentEnabled,
      adoptedLabel: 'Enabled',
      notAdoptedLabel: 'Not enabled',
      actionLabel: state.securityAgentEnabled ? 'Review settings' : 'Enable Security Agent',
      actionUrl: `/organizations/${organizationId}/security-agent/config`,
    },
    {
      key: 'team-integration',
      title: 'Team workflow connected',
      description: 'Connect Slack, Discord, or Linear to bring Kilo into your team workflow.',
      adopted: state.teamIntegrationConnected,
      adoptedLabel: 'Connected',
      notAdoptedLabel: 'Not connected',
      actionLabel: state.teamIntegrationConnected
        ? 'Manage integrations'
        : 'Connect an integration',
      actionUrl: `/organizations/${organizationId}/integrations`,
    },
    {
      key: 'cloud-agent-used',
      title: 'Cloud Agent',
      description: 'Start a Cloud Agent session for organization development work.',
      adopted: state.cloudAgentUsed,
      adoptedLabel: 'Used',
      notAdoptedLabel: 'Not used',
      actionLabel: state.cloudAgentUsed ? 'View Cloud Agent' : 'Start with Cloud Agent',
      actionUrl: `/organizations/${organizationId}/cloud`,
    },
    {
      key: 'project-deployed',
      title: 'Deploy',
      description: 'Deploy a project from a connected repository.',
      adopted: state.projectDeployed,
      adoptedLabel: 'Deployed',
      notAdoptedLabel: 'Not deployed',
      actionLabel: state.projectDeployed ? 'View deployments' : 'Deploy a project',
      actionUrl: `/organizations/${organizationId}/deploy`,
    },
  ];
}

export async function getFeatureAdoptionState(
  organizationId: string
): Promise<FeatureAdoptionState> {
  const result = await readDb.execute(sql`
    SELECT
      EXISTS (
        SELECT 1 FROM platform_integrations
        WHERE owned_by_organization_id = ${organizationId}
          AND platform IN ('github', 'gitlab')
          AND integration_status = ${INTEGRATION_STATUS.ACTIVE}
          AND suspended_at IS NULL
          AND auth_invalid_at IS NULL
      ) AS source_control_connected,
      EXISTS (
        SELECT 1 FROM agent_configs
        WHERE owned_by_organization_id = ${organizationId}
          AND agent_type = 'code_review'
          AND platform IN ('github', 'gitlab')
          AND is_enabled = true
      ) AS code_reviewer_enabled,
      EXISTS (
        SELECT 1 FROM agent_configs
        WHERE owned_by_organization_id = ${organizationId}
          AND agent_type = 'security_scan'
          AND platform = 'github'
          AND is_enabled = true
      ) AS security_agent_enabled,
      EXISTS (
        SELECT 1 FROM platform_integrations
        WHERE owned_by_organization_id = ${organizationId}
          AND integration_status = ${INTEGRATION_STATUS.ACTIVE}
          AND suspended_at IS NULL
          AND auth_invalid_at IS NULL
          AND (
            platform IN ('slack', 'discord') OR
            (platform = 'linear' AND metadata -> 'bot_enabled' = 'true'::jsonb)
          )
      ) AS team_integration_connected,
      (
        EXISTS (
          SELECT 1 FROM cli_sessions_v2
          WHERE organization_id = ${organizationId}
            AND cloud_agent_session_id IS NOT NULL
        ) OR EXISTS (
          SELECT 1 FROM cli_sessions
          WHERE organization_id = ${organizationId}
            AND cloud_agent_session_id IS NOT NULL
        )
      ) AS cloud_agent_used,
      EXISTS (
        SELECT 1 FROM deployments
        WHERE owned_by_organization_id = ${organizationId}
          AND created_from = 'deploy'
          AND last_deployed_at IS NOT NULL
      ) AS project_deployed
  `);
  const row = result.rows[0] as FeatureAdoptionStateRow | undefined;
  return {
    sourceControlConnected: row?.source_control_connected ?? false,
    codeReviewerEnabled: row?.code_reviewer_enabled ?? false,
    securityAgentEnabled: row?.security_agent_enabled ?? false,
    teamIntegrationConnected: row?.team_integration_connected ?? false,
    cloudAgentUsed: row?.cloud_agent_used ?? false,
    projectDeployed: row?.project_deployed ?? false,
  };
}

export async function getOrganizationFeatureAdoption(organizationId: string): Promise<{
  plan: 'teams' | 'enterprise';
  checks: FeatureAdoptionCheck[];
}> {
  const organizationRows = await readDb
    .select({ plan: organizations.plan })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
    .limit(1);
  const organization = organizationRows[0];
  if (!organization) {
    throw new Error('Organization not found');
  }
  if (organization.plan !== 'enterprise') {
    return { plan: organization.plan, checks: [] };
  }

  const state = await getFeatureAdoptionState(organizationId);

  return {
    plan: organization.plan,
    checks: buildFeatureAdoptionChecks(organizationId, state),
  };
}

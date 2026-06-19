import { organizations } from '@kilocode/db/schema';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { readDb } from '@/lib/drizzle';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';

export const FEATURE_ADOPTION_KEYS = [
  'source-control-integration',
  'code-reviewer',
  'security-agent',
  'cloud-agent-webhook',
  'team-integration',
] as const;

export type FeatureAdoptionKey = (typeof FEATURE_ADOPTION_KEYS)[number];

export type FeatureAdoptionCheck = {
  key: FeatureAdoptionKey;
  title: string;
  description: string;
  adopted: boolean;
  actionLabel: string;
  actionUrl: string;
};

type FeatureAdoptionState = {
  sourceControlConnected: boolean;
  codeReviewerEnabled: boolean;
  securityAgentEnabled: boolean;
  hasActiveCloudAgentWebhook: boolean;
  teamIntegrationConnected: boolean;
};

type FeatureAdoptionStateRow = {
  source_control_connected: boolean;
  code_reviewer_enabled: boolean;
  security_agent_enabled: boolean;
  has_active_cloud_agent_webhook: boolean;
  team_integration_connected: boolean;
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
      actionLabel: state.sourceControlConnected ? 'Manage integrations' : 'Connect source control',
      actionUrl: `/organizations/${organizationId}/integrations`,
    },
    {
      key: 'code-reviewer',
      title: 'Code Reviewer enabled',
      description: 'Run AI assisted reviews on pull requests or merge requests.',
      adopted: state.codeReviewerEnabled,
      actionLabel: state.codeReviewerEnabled ? 'Review settings' : 'Enable Code Reviewer',
      actionUrl: `/organizations/${organizationId}/code-reviews`,
    },
    {
      key: 'security-agent',
      title: 'Security Agent enabled',
      description: 'Monitor repositories for Security Findings and remediation opportunities.',
      adopted: state.securityAgentEnabled,
      actionLabel: state.securityAgentEnabled ? 'Review settings' : 'Enable Security Agent',
      actionUrl: `/organizations/${organizationId}/security-agent/config`,
    },
    {
      key: 'cloud-agent-webhook',
      title: 'Cloud Agent automation configured',
      description: 'Start Cloud Agent work from an active external webhook trigger.',
      adopted: state.hasActiveCloudAgentWebhook,
      actionLabel: state.hasActiveCloudAgentWebhook ? 'Manage triggers' : 'Create webhook trigger',
      actionUrl: `/organizations/${organizationId}/cloud/triggers${state.hasActiveCloudAgentWebhook ? '' : '/new'}`,
    },
    {
      key: 'team-integration',
      title: 'Team workflow connected',
      description: 'Connect Slack, Discord, or Linear to bring Kilo into your team workflow.',
      adopted: state.teamIntegrationConnected,
      actionLabel: state.teamIntegrationConnected
        ? 'Manage integrations'
        : 'Connect an integration',
      actionUrl: `/organizations/${organizationId}/integrations`,
    },
  ];
}

async function getFeatureAdoptionState(organizationId: string): Promise<FeatureAdoptionState> {
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
        SELECT 1 FROM cloud_agent_webhook_triggers
        WHERE organization_id = ${organizationId}
          AND target_type = 'cloud_agent'
          AND activation_mode = 'webhook'
          AND is_active = true
      ) AS has_active_cloud_agent_webhook,
      EXISTS (
        SELECT 1 FROM platform_integrations
        WHERE owned_by_organization_id = ${organizationId}
          AND platform IN ('slack', 'discord', 'linear')
          AND integration_status = ${INTEGRATION_STATUS.ACTIVE}
          AND suspended_at IS NULL
          AND auth_invalid_at IS NULL
      ) AS team_integration_connected
  `);
  const row = result.rows[0] as FeatureAdoptionStateRow | undefined;
  return {
    sourceControlConnected: row?.source_control_connected ?? false,
    codeReviewerEnabled: row?.code_reviewer_enabled ?? false,
    securityAgentEnabled: row?.security_agent_enabled ?? false,
    hasActiveCloudAgentWebhook: row?.has_active_cloud_agent_webhook ?? false,
    teamIntegrationConnected: row?.team_integration_connected ?? false,
  };
}

export async function getOrganizationPendingFeatureAdoptionCount(
  organizationId: string
): Promise<{ plan: 'teams' | 'enterprise'; pendingCount: number }> {
  const adoption = await getOrganizationFeatureAdoption(organizationId);
  return {
    plan: adoption.plan,
    pendingCount: adoption.checks.filter(check => !check.adopted).length,
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

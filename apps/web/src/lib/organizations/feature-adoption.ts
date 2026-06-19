import {
  agent_configs,
  cloud_agent_webhook_triggers,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, eq, inArray, isNull } from 'drizzle-orm';
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

type AdoptionAgentConfig = {
  agentType: string;
  platform: string;
  isEnabled: boolean;
};

type AdoptionIntegration = {
  platform: string;
  status: string | null;
  suspendedAt: string | null;
  authInvalidAt: string | null;
};

type FeatureAdoptionState = {
  agentConfigs: AdoptionAgentConfig[];
  integrations: AdoptionIntegration[];
  hasActiveCloudAgentWebhook: boolean;
};

const SOURCE_CONTROL_PLATFORMS = ['github', 'gitlab'];
const TEAM_INTEGRATION_PLATFORMS = ['slack', 'discord', 'linear'];

function hasHealthyIntegration(integrations: AdoptionIntegration[], platforms: string[]): boolean {
  return integrations.some(
    integration =>
      platforms.includes(integration.platform) &&
      integration.status === INTEGRATION_STATUS.ACTIVE &&
      integration.suspendedAt === null &&
      integration.authInvalidAt === null
  );
}

export function buildFeatureAdoptionChecks(
  organizationId: string,
  state: FeatureAdoptionState
): FeatureAdoptionCheck[] {
  const sourceControlConnected = hasHealthyIntegration(
    state.integrations,
    SOURCE_CONTROL_PLATFORMS
  );
  const teamIntegrationConnected = hasHealthyIntegration(
    state.integrations,
    TEAM_INTEGRATION_PLATFORMS
  );
  const codeReviewerEnabled = state.agentConfigs.some(
    config =>
      config.agentType === 'code_review' &&
      SOURCE_CONTROL_PLATFORMS.includes(config.platform) &&
      config.isEnabled
  );
  const securityAgentEnabled = state.agentConfigs.some(
    config =>
      config.agentType === 'security_scan' && config.platform === 'github' && config.isEnabled
  );

  return [
    {
      key: 'source-control-integration',
      title: 'Source control connected',
      description:
        'Connect GitHub or GitLab to bring repositories and development workflows into Kilo.',
      adopted: sourceControlConnected,
      actionLabel: sourceControlConnected ? 'Manage integrations' : 'Connect source control',
      actionUrl: `/organizations/${organizationId}/integrations`,
    },
    {
      key: 'code-reviewer',
      title: 'Code Reviewer enabled',
      description: 'Run AI-assisted reviews on pull requests or merge requests.',
      adopted: codeReviewerEnabled,
      actionLabel: codeReviewerEnabled ? 'Review settings' : 'Enable Code Reviewer',
      actionUrl: `/organizations/${organizationId}/code-reviews`,
    },
    {
      key: 'security-agent',
      title: 'Security Agent enabled',
      description: 'Monitor repositories for Security Findings and remediation opportunities.',
      adopted: securityAgentEnabled,
      actionLabel: securityAgentEnabled ? 'Review settings' : 'Enable Security Agent',
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
      adopted: teamIntegrationConnected,
      actionLabel: teamIntegrationConnected ? 'Manage integrations' : 'Connect an integration',
      actionUrl: `/organizations/${organizationId}/integrations`,
    },
  ];
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

  const [agentConfigRows, integrationRows, webhookRows] = await Promise.all([
    readDb
      .select({
        agentType: agent_configs.agent_type,
        platform: agent_configs.platform,
        isEnabled: agent_configs.is_enabled,
      })
      .from(agent_configs)
      .where(
        and(
          eq(agent_configs.owned_by_organization_id, organizationId),
          inArray(agent_configs.agent_type, ['code_review', 'security_scan'])
        )
      ),
    readDb
      .select({
        platform: platform_integrations.platform,
        status: platform_integrations.integration_status,
        suspendedAt: platform_integrations.suspended_at,
        authInvalidAt: platform_integrations.auth_invalid_at,
      })
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, organizationId)),
    readDb
      .select({ id: cloud_agent_webhook_triggers.id })
      .from(cloud_agent_webhook_triggers)
      .where(
        and(
          eq(cloud_agent_webhook_triggers.organization_id, organizationId),
          eq(cloud_agent_webhook_triggers.target_type, 'cloud_agent'),
          eq(cloud_agent_webhook_triggers.activation_mode, 'webhook'),
          eq(cloud_agent_webhook_triggers.is_active, true)
        )
      )
      .limit(1),
  ]);

  return {
    plan: organization.plan,
    checks: buildFeatureAdoptionChecks(organizationId, {
      agentConfigs: agentConfigRows,
      integrations: integrationRows,
      hasActiveCloudAgentWebhook: webhookRows.length > 0,
    }),
  };
}

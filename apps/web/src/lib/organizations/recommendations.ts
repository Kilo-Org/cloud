import {
  agent_configs,
  cloud_agent_webhook_triggers,
  organization_memberships,
  organization_recommendation_dismissals,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { readDb } from '@/lib/drizzle';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';

export const RECOMMENDATION_KEYS = [
  'integration-needs-reconnect',
  'org-github-lite-app',
  'code-reviewer-security-focus-missing',
  'code-reviewer-no-merge-gate',
  'security-agent-sla-disabled',
  'security-agent-auto-analysis-disabled',
  'linear-bot-disabled',
  'cloud-agent-no-automation',
  'org-sso-not-configured',
  'org-unused-seats',
] as const;

export type RecommendationKey = (typeof RECOMMENDATION_KEYS)[number];

export type RecommendationSeverity = 'attention' | 'suggestion';

export type Recommendation = {
  key: RecommendationKey;
  title: string;
  description: string;
  actionLabel: string;
  actionUrl: string;
  severity: RecommendationSeverity;
};

export type RecommendationState = {
  codeReviewerEnabled: boolean;
  codeReviewMissingSecurityFocus: boolean;
  codeReviewGateOff: boolean;
  securityAgentEnabled: boolean;
  securitySlaDisabled: boolean;
  securityAutoAnalysisDisabled: boolean;
  brokenIntegrationPlatforms: string[];
  linearConnected: boolean;
  linearBotEnabled: boolean;
  cloudAgentUsed: boolean;
  webhookTriggerCount: number;
  githubLiteApp: boolean;
  ssoConfigured: boolean;
  seatCount: number;
  memberCount: number;
};

const PLATFORM_LABELS: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  azure_devops: 'Azure DevOps',
  slack: 'Slack',
  discord: 'Discord',
  linear: 'Linear',
};

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/**
 * Pure rule evaluation. Order encodes priority: broken/blocking states first,
 * then per-feature tuning, then organization-level suggestions. Recommendations
 * for a feature are only emitted when that feature is enabled (enablement-first);
 * the only exceptions are reconnect/bot states, which are themselves enablement
 * problems surfaced here.
 */
export function buildRecommendations(
  organizationId: string,
  state: RecommendationState
): Recommendation[] {
  const recommendations: Recommendation[] = [];
  const integrationsUrl = `/organizations/${organizationId}/integrations`;
  const codeReviewsUrl = `/organizations/${organizationId}/code-reviews`;
  const securityAgentUrl = `/organizations/${organizationId}/security-agent/config`;
  const organizationUrl = `/organizations/${organizationId}`;

  // A6 — a connected integration is broken and needs reauthorization.
  if (state.brokenIntegrationPlatforms.length > 0) {
    const labels = state.brokenIntegrationPlatforms.map(platformLabel);
    const title = labels.length === 1 ? `Reconnect ${labels[0]}` : 'Reconnect integrations';
    recommendations.push({
      key: 'integration-needs-reconnect',
      title,
      description:
        labels.length === 1
          ? `${labels[0]} needs reauthorization. Automation is paused until you reconnect it.`
          : `${labels.join(' and ')} need reauthorization. Automation is paused until you reconnect them.`,
      actionLabel: 'Reconnect',
      actionUrl: integrationsUrl,
      severity: 'attention',
    });
  }

  // C2 — read-only GitHub app blocks write-back features. Upstream of the merge gate.
  if (state.githubLiteApp) {
    recommendations.push({
      key: 'org-github-lite-app',
      title: 'Switch to the full GitHub app',
      description:
        'You are on the read-only GitHub app. Code Reviewer cannot post results or gate pull requests until you switch to the full app.',
      actionLabel: 'Update GitHub app',
      actionUrl: integrationsUrl,
      severity: 'suggestion',
    });
  }

  // A1 — Code Reviewer enabled but Security is not a selected focus area.
  if (state.codeReviewerEnabled && state.codeReviewMissingSecurityFocus) {
    recommendations.push({
      key: 'code-reviewer-security-focus-missing',
      title: 'Add a security review focus',
      description:
        'Code Reviewer is on, but Security vulnerabilities is not a selected focus area. Add it for extra emphasis on issues like injection and leaked credentials.',
      actionLabel: 'Update focus areas',
      actionUrl: codeReviewsUrl,
      severity: 'suggestion',
    });
  }

  // A2 — Code Reviewer enabled but no merge gate. Impossible on the lite app, so
  // only suggest it when the full app is in use (C2 covers the lite case).
  if (state.codeReviewerEnabled && state.codeReviewGateOff && !state.githubLiteApp) {
    recommendations.push({
      key: 'code-reviewer-no-merge-gate',
      title: 'Turn on a merge gate',
      description:
        'Code Reviewer posts comments but does not gate pull requests. Set a gate threshold so risky changes are flagged.',
      actionLabel: 'Set a gate threshold',
      actionUrl: codeReviewsUrl,
      severity: 'suggestion',
    });
  }

  // A3 — Security Agent enabled but SLAs off.
  if (state.securityAgentEnabled && state.securitySlaDisabled) {
    recommendations.push({
      key: 'security-agent-sla-disabled',
      title: 'Set Security Agent SLA deadlines',
      description: 'Findings have no due dates. Turn on SLAs so issues get a deadline.',
      actionLabel: 'Set SLA deadlines',
      actionUrl: securityAgentUrl,
      severity: 'suggestion',
    });
  }

  // A4 — Security Agent enabled but new findings are not analyzed automatically.
  if (state.securityAgentEnabled && state.securityAutoAnalysisDisabled) {
    recommendations.push({
      key: 'security-agent-auto-analysis-disabled',
      title: 'Turn on automatic analysis',
      description:
        'New findings are not analyzed automatically. Turn on analysis so they are triaged as they arrive.',
      actionLabel: 'Enable auto analysis',
      actionUrl: securityAgentUrl,
      severity: 'suggestion',
    });
  }

  // A7 — Linear connected but its bot is off.
  if (state.linearConnected && !state.linearBotEnabled) {
    recommendations.push({
      key: 'linear-bot-disabled',
      title: 'Enable the Linear bot',
      description: 'Linear is connected but the bot is off, so it cannot act on issues.',
      actionLabel: 'Enable the bot',
      actionUrl: integrationsUrl,
      severity: 'suggestion',
    });
  }

  // A8 — Cloud Agent used but never automated.
  if (state.cloudAgentUsed && state.webhookTriggerCount === 0) {
    recommendations.push({
      key: 'cloud-agent-no-automation',
      title: 'Automate Cloud Agent',
      description:
        'Cloud Agent runs only manually. Add a webhook trigger to start it from your tools.',
      actionLabel: 'Create a trigger',
      actionUrl: `/organizations/${organizationId}/cloud/triggers`,
      severity: 'suggestion',
    });
  }

  // C1 — SSO not configured.
  if (!state.ssoConfigured) {
    recommendations.push({
      key: 'org-sso-not-configured',
      title: 'Set up SSO',
      description: 'Single sign-on is not configured for this organization.',
      actionLabel: 'Set up SSO',
      actionUrl: organizationUrl,
      severity: 'suggestion',
    });
  }

  // C3 — paid seats that nobody is using.
  if (state.seatCount > state.memberCount) {
    recommendations.push({
      key: 'org-unused-seats',
      title: 'Invite more members',
      description: 'You have unused seats. Invite teammates to use them.',
      actionLabel: 'Invite members',
      actionUrl: organizationUrl,
      severity: 'suggestion',
    });
  }

  return recommendations;
}

function readBoolean(config: unknown, key: string): boolean | undefined {
  if (config && typeof config === 'object' && key in config) {
    const value = (config as Record<string, unknown>)[key];
    return typeof value === 'boolean' ? value : undefined;
  }
  return undefined;
}

function readStringArray(config: unknown, key: string): string[] {
  if (config && typeof config === 'object' && key in config) {
    const value = (config as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string');
    }
  }
  return [];
}

function readString(config: unknown, key: string): string | undefined {
  if (config && typeof config === 'object' && key in config) {
    const value = (config as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
}

async function getRecommendationState(organizationId: string): Promise<RecommendationState> {
  const [agentConfigRows, integrationRows, triggerRows, memberRows, cloudUsedResult] =
    await Promise.all([
      readDb
        .select({
          agent_type: agent_configs.agent_type,
          platform: agent_configs.platform,
          is_enabled: agent_configs.is_enabled,
          config: agent_configs.config,
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
          integration_status: platform_integrations.integration_status,
          auth_invalid_at: platform_integrations.auth_invalid_at,
          suspended_at: platform_integrations.suspended_at,
          github_app_type: platform_integrations.github_app_type,
          metadata: platform_integrations.metadata,
        })
        .from(platform_integrations)
        .where(eq(platform_integrations.owned_by_organization_id, organizationId)),
      readDb
        .select({ value: count() })
        .from(cloud_agent_webhook_triggers)
        .where(eq(cloud_agent_webhook_triggers.organization_id, organizationId)),
      readDb
        .select({ value: count() })
        .from(organization_memberships)
        .where(eq(organization_memberships.organization_id, organizationId)),
      readDb.execute(sql`
        SELECT (
          EXISTS (
            SELECT 1 FROM cli_sessions_v2
            WHERE organization_id = ${organizationId} AND cloud_agent_session_id IS NOT NULL
          ) OR EXISTS (
            SELECT 1 FROM cli_sessions
            WHERE organization_id = ${organizationId} AND cloud_agent_session_id IS NOT NULL
          )
        ) AS used
      `),
    ]);

  const enabledCodeReviewConfigs = agentConfigRows.filter(
    row =>
      row.agent_type === 'code_review' &&
      row.is_enabled &&
      (row.platform === 'github' || row.platform === 'gitlab')
  );
  const enabledSecurityConfigs = agentConfigRows.filter(
    row => row.agent_type === 'security_scan' && row.is_enabled && row.platform === 'github'
  );

  const codeReviewerEnabled = enabledCodeReviewConfigs.length > 0;
  const securityAgentEnabled = enabledSecurityConfigs.length > 0;

  const isBroken = (row: (typeof integrationRows)[number]) =>
    row.integration_status === INTEGRATION_STATUS.SUSPENDED ||
    row.auth_invalid_at !== null ||
    row.suspended_at !== null;
  const isActive = (row: (typeof integrationRows)[number]) =>
    row.integration_status === INTEGRATION_STATUS.ACTIVE && !isBroken(row);

  const brokenIntegrationPlatforms = Array.from(
    new Set(integrationRows.filter(isBroken).map(row => row.platform))
  );

  const activeLinear = integrationRows.filter(row => row.platform === 'linear' && isActive(row));
  const linearConnected = activeLinear.length > 0;
  const linearBotEnabled = activeLinear.some(
    row => readBoolean(row.metadata, 'bot_enabled') === true
  );

  const githubLiteApp = integrationRows.some(
    row => row.platform === 'github' && isActive(row) && row.github_app_type === 'lite'
  );

  const orgRow = await readDb
    .select({ sso_domain: organizations.sso_domain, seat_count: organizations.seat_count })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const sso = orgRow[0]?.sso_domain ?? null;

  return {
    codeReviewerEnabled,
    codeReviewMissingSecurityFocus: enabledCodeReviewConfigs.some(
      row => !readStringArray(row.config, 'focus_areas').includes('security')
    ),
    codeReviewGateOff: enabledCodeReviewConfigs.some(
      row => readString(row.config, 'gate_threshold') === 'off'
    ),
    securityAgentEnabled,
    securitySlaDisabled: enabledSecurityConfigs.some(
      row => readBoolean(row.config, 'sla_enabled') === false
    ),
    securityAutoAnalysisDisabled: enabledSecurityConfigs.some(
      row => readBoolean(row.config, 'auto_analysis_enabled') !== true
    ),
    brokenIntegrationPlatforms,
    linearConnected,
    linearBotEnabled,
    cloudAgentUsed: cloudUsedResult.rows[0]?.used === true,
    webhookTriggerCount: triggerRows[0]?.value ?? 0,
    githubLiteApp,
    ssoConfigured: sso !== null && sso !== '',
    seatCount: orgRow[0]?.seat_count ?? 0,
    memberCount: memberRows[0]?.value ?? 0,
  };
}

export async function getOrganizationRecommendations(organizationId: string): Promise<{
  plan: 'teams' | 'enterprise';
  recommendations: Recommendation[];
}> {
  const orgRows = await readDb
    .select({ plan: organizations.plan })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const organization = orgRows[0];
  if (!organization) {
    throw new Error('Organization not found');
  }
  if (organization.plan !== 'enterprise') {
    return { plan: organization.plan, recommendations: [] };
  }

  const [state, dismissedRows] = await Promise.all([
    getRecommendationState(organizationId),
    readDb
      .select({ key: organization_recommendation_dismissals.recommendation_key })
      .from(organization_recommendation_dismissals)
      .where(eq(organization_recommendation_dismissals.owned_by_organization_id, organizationId)),
  ]);

  const dismissed = new Set(dismissedRows.map(row => row.key));
  const recommendations = buildRecommendations(organizationId, state).filter(
    recommendation => !dismissed.has(recommendation.key)
  );

  return { plan: organization.plan, recommendations };
}

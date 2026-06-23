import {
  agent_configs,
  cloud_agent_webhook_triggers,
  organization_recommendation_dismissals,
  organizations,
  platform_integrations,
} from '@kilocode/db/schema';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { readDb } from '@/lib/drizzle';
import { INTEGRATION_STATUS } from '@/lib/integrations/core/constants';
import {
  FEATURE_ADOPTION_KEYS,
  buildFeatureAdoptionChecks,
  getFeatureAdoptionState,
} from '@/lib/organizations/feature-adoption';
import { getOrganizationSeatUsage } from '@/lib/organizations/organization-seats';
import { resolveEffectiveOrganizationSsoPolicy } from '@/lib/organizations/organization-sso-policy';

// Which surface a recommendation ties back to. Per-feature recommendations reuse
// the feature adoption key so the UI can show the same icon; organization-level
// ones (SSO, seats) are not tied to one feature.
export const RECOMMENDATION_FEATURES = [...FEATURE_ADOPTION_KEYS, 'organization'] as const;

export type RecommendationFeature = (typeof RECOMMENDATION_FEATURES)[number];

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

// open = the gap still exists, completed = the org reached the good state,
// dismissed = an owner chose to stop seeing it.
export type RecommendationStatus = 'open' | 'completed' | 'dismissed';

export type Recommendation = {
  key: RecommendationKey;
  feature: RecommendationFeature;
  status: RecommendationStatus;
  title: string;
  description: string;
  actionLabel: string;
  actionUrl: string;
  severity: RecommendationSeverity;
};

export type RecommendationState = {
  sourceControlConnected: boolean;
  codeReviewerEnabled: boolean;
  codeReviewMissingSecurityFocus: boolean;
  // Whether at least one enabled Code Reviewer config can support a merge gate on
  // its platform (GitLab always can; GitHub only on the full app). The gate rule
  // is suppressed only when no enabled config can gate.
  codeReviewGateApplicable: boolean;
  // Whether any gate-capable config still has the gate off.
  codeReviewGateOff: boolean;
  securityAgentEnabled: boolean;
  securitySlaDisabled: boolean;
  securityAutoAnalysisDisabled: boolean;
  brokenIntegrationPlatforms: string[];
  linearConnected: boolean;
  linearBotEnabled: boolean;
  teamIntegrationConnected: boolean;
  cloudAgentUsed: boolean;
  projectDeployed: boolean;
  webhookTriggerCount: number;
  githubConnected: boolean;
  githubLiteApp: boolean;
  ssoConfigured: boolean;
  // Canonical seat accounting from getOrganizationSeatUsage (excludes billing
  // managers); seatCount is the purchased total.
  seatCount: number;
  seatsUsed: number;
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

type RuleContent = {
  title: string;
  description: string;
  actionLabel: string;
  actionUrl: string;
};

type Rule = {
  key: RecommendationKey;
  feature: RecommendationFeature;
  severity: RecommendationSeverity;
  // The done-phrased copy shown in the Completed list. Omit for break-fix items
  // (reconnect) that are open-only: "no broken integrations" is not a milestone.
  completed?: { title: string; description: string };
  applicable: (state: RecommendationState) => boolean;
  // True when the gap still exists (the org should act).
  open: (state: RecommendationState) => boolean;
  content: (organizationId: string, state: RecommendationState) => RuleContent;
};

function integrationsUrl(organizationId: string): string {
  return `/organizations/${organizationId}/integrations`;
}
function codeReviewsUrl(organizationId: string): string {
  return `/organizations/${organizationId}/code-reviews`;
}
function securityAgentUrl(
  organizationId: string,
  tab: 'automation' | 'notifications' | 'sla'
): string {
  return `/organizations/${organizationId}/security-agent/config?tab=${tab}`;
}
function organizationUrl(organizationId: string): string {
  return `/organizations/${organizationId}`;
}

// Order encodes priority within a pane: broken/blocking first, then per-feature
// tuning, then organization-level. Per-feature rules are only applicable when the
// feature is enabled (enablement-first); reconnect/bot states are themselves the
// enablement problem.
const RULES: Rule[] = [
  {
    key: 'integration-needs-reconnect',
    feature: 'source-control-integration',
    severity: 'attention',
    applicable: state => state.brokenIntegrationPlatforms.length > 0,
    open: state => state.brokenIntegrationPlatforms.length > 0,
    content: (organizationId, state) => {
      const labels = state.brokenIntegrationPlatforms.map(platformLabel);
      return {
        title: labels.length === 1 ? `Reconnect ${labels[0]}` : 'Reconnect integrations',
        description:
          labels.length === 1
            ? `${labels[0]} needs reauthorization. Automation is paused until you reconnect it.`
            : `${labels.join(' and ')} need reauthorization. Automation is paused until you reconnect them.`,
        actionLabel: 'Reconnect',
        actionUrl: integrationsUrl(organizationId),
      };
    },
  },
  {
    key: 'org-github-lite-app',
    feature: 'source-control-integration',
    severity: 'suggestion',
    completed: {
      title: 'Using the full GitHub app',
      description: 'Code Reviewer can post results and gate pull requests.',
    },
    applicable: state => state.githubConnected,
    open: state => state.githubLiteApp,
    content: organizationId => ({
      title: 'Switch to the full GitHub app',
      description:
        'You are on the read-only GitHub app. Code Reviewer cannot post results or gate pull requests until you switch to the full app.',
      actionLabel: 'Update GitHub app',
      actionUrl: integrationsUrl(organizationId),
    }),
  },
  {
    key: 'code-reviewer-security-focus-missing',
    feature: 'code-reviewer',
    severity: 'suggestion',
    completed: {
      title: 'Security review focus enabled',
      description: 'Code Reviewer emphasizes security vulnerabilities.',
    },
    applicable: state => state.codeReviewerEnabled,
    open: state => state.codeReviewMissingSecurityFocus,
    content: organizationId => ({
      title: 'Add a security review focus',
      description:
        'Code Reviewer is on, but Security vulnerabilities is not a selected focus area. Add it for extra emphasis on issues like injection and leaked credentials.',
      actionLabel: 'Update focus areas',
      actionUrl: codeReviewsUrl(organizationId),
    }),
  },
  {
    key: 'code-reviewer-no-merge-gate',
    feature: 'code-reviewer',
    severity: 'suggestion',
    completed: {
      title: 'Merge gate enabled',
      description: 'Code Reviewer gates pull requests on findings.',
    },
    // Applicable when an enabled config can actually gate on its platform. A
    // GitHub-only org on the read-only app cannot, so the rule is suppressed
    // there (C2 covers the upgrade); a GitLab config is unaffected.
    applicable: state => state.codeReviewGateApplicable,
    open: state => state.codeReviewGateOff,
    content: organizationId => ({
      title: 'Turn on a merge gate',
      description:
        'Code Reviewer posts comments but does not gate pull requests. Set a gate threshold so risky changes are flagged.',
      actionLabel: 'Set a gate threshold',
      actionUrl: codeReviewsUrl(organizationId),
    }),
  },
  {
    key: 'security-agent-sla-disabled',
    feature: 'security-agent',
    severity: 'suggestion',
    completed: {
      title: 'SLA deadlines set',
      description: 'Security findings get a due date.',
    },
    applicable: state => state.securityAgentEnabled,
    open: state => state.securitySlaDisabled,
    content: organizationId => ({
      title: 'Set Security Agent SLA deadlines',
      description: 'Findings have no due dates. Turn on SLAs so issues get a deadline.',
      actionLabel: 'Set SLA deadlines',
      actionUrl: securityAgentUrl(organizationId, 'sla'),
    }),
  },
  {
    key: 'security-agent-auto-analysis-disabled',
    feature: 'security-agent',
    severity: 'suggestion',
    completed: {
      title: 'Automatic analysis on',
      description: 'New findings are triaged as they arrive.',
    },
    applicable: state => state.securityAgentEnabled,
    open: state => state.securityAutoAnalysisDisabled,
    content: organizationId => ({
      title: 'Turn on automatic analysis',
      description:
        'New findings are not analyzed automatically. Turn on analysis so they are triaged as they arrive.',
      actionLabel: 'Enable auto analysis',
      actionUrl: securityAgentUrl(organizationId, 'automation'),
    }),
  },
  {
    key: 'linear-bot-disabled',
    feature: 'team-integration',
    severity: 'suggestion',
    completed: {
      title: 'Linear bot enabled',
      description: 'The bot can act on issues.',
    },
    applicable: state => state.linearConnected,
    open: state => !state.linearBotEnabled,
    content: organizationId => ({
      title: 'Enable the Linear bot',
      description: 'Linear is connected but the bot is off, so it cannot act on issues.',
      actionLabel: 'Enable the bot',
      actionUrl: integrationsUrl(organizationId),
    }),
  },
  {
    key: 'cloud-agent-no-automation',
    feature: 'cloud-agent-used',
    severity: 'suggestion',
    completed: {
      title: 'Cloud Agent automated',
      description: 'A trigger can start Cloud Agent from your tools.',
    },
    applicable: state => state.cloudAgentUsed,
    open: state => state.webhookTriggerCount === 0,
    content: organizationId => ({
      title: 'Automate Cloud Agent',
      description:
        'Cloud Agent runs only manually. Add a webhook trigger to start it from your tools.',
      actionLabel: 'Create a trigger',
      actionUrl: `/organizations/${organizationId}/cloud/triggers`,
    }),
  },
  {
    key: 'org-sso-not-configured',
    feature: 'organization',
    severity: 'suggestion',
    completed: {
      title: 'SSO configured',
      description: 'Single sign-on is set up for this organization.',
    },
    applicable: () => true,
    open: state => !state.ssoConfigured,
    content: organizationId => ({
      title: 'Set up SSO',
      description: 'Single sign-on is not configured for this organization.',
      actionLabel: 'Set up SSO',
      actionUrl: organizationUrl(organizationId),
    }),
  },
  {
    key: 'org-unused-seats',
    feature: 'organization',
    severity: 'suggestion',
    completed: {
      title: 'All seats in use',
      description: 'Every paid seat is assigned.',
    },
    applicable: () => true,
    open: state => state.seatCount > state.seatsUsed,
    content: organizationId => ({
      title: 'Invite more members',
      description: 'You have unused seats. Invite teammates to use them.',
      actionLabel: 'Invite members',
      actionUrl: organizationUrl(organizationId),
    }),
  },
];

/**
 * Pure rule evaluation. Returns every applicable rule with an open/completed
 * status. Dismissals are applied separately in getOrganizationRecommendations.
 * Non-applicable rules (feature disabled, nothing connected) are omitted.
 */
export function buildRecommendations(
  organizationId: string,
  state: RecommendationState
): Recommendation[] {
  const recommendations: Recommendation[] = [];
  for (const rule of RULES) {
    if (!rule.applicable(state)) {
      continue;
    }
    const isOpen = rule.open(state);
    if (!isOpen && !rule.completed) {
      continue;
    }
    const content = rule.content(organizationId, state);
    recommendations.push({
      key: rule.key,
      feature: rule.feature,
      status: isOpen ? 'open' : 'completed',
      severity: rule.severity,
      title: isOpen ? content.title : (rule.completed?.title ?? content.title),
      description: isOpen
        ? content.description
        : (rule.completed?.description ?? content.description),
      actionLabel: content.actionLabel,
      actionUrl: content.actionUrl,
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
  const [featureAdoption, agentConfigRows, integrationRows, triggerRows, seatUsage, ssoPolicy] =
    await Promise.all([
      getFeatureAdoptionState(organizationId),
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
        .where(
          and(
            eq(cloud_agent_webhook_triggers.organization_id, organizationId),
            eq(cloud_agent_webhook_triggers.target_type, 'cloud_agent'),
            eq(cloud_agent_webhook_triggers.is_active, true)
          )
        ),
      getOrganizationSeatUsage(organizationId),
      resolveEffectiveOrganizationSsoPolicy(organizationId),
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
  const activeGithub = integrationRows.filter(row => row.platform === 'github' && isActive(row));
  const githubConnected = activeGithub.length > 0;
  const githubLiteApp =
    githubConnected && activeGithub.every(row => row.github_app_type === 'lite');

  // A merge gate posts a check run (GitHub) or commit status (GitLab). GitLab can
  // always gate; GitHub can only gate on the full app, not the read-only one.
  const gateCapableCodeReviewConfigs = enabledCodeReviewConfigs.filter(
    row => row.platform === 'gitlab' || (row.platform === 'github' && !githubLiteApp)
  );

  return {
    ...featureAdoption,
    codeReviewerEnabled,
    codeReviewMissingSecurityFocus: enabledCodeReviewConfigs.some(
      row => !readStringArray(row.config, 'focus_areas').includes('security')
    ),
    codeReviewGateApplicable: gateCapableCodeReviewConfigs.length > 0,
    // Code Reviewer treats a missing gate_threshold as 'off' everywhere it is
    // consumed (e.g. prepare-review-payload.ts), so a config with no threshold
    // means no gate is active. Match that default here.
    codeReviewGateOff: gateCapableCodeReviewConfigs.some(
      row => (readString(row.config, 'gate_threshold') ?? 'off') === 'off'
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
    webhookTriggerCount: triggerRows[0]?.value ?? 0,
    githubConnected,
    githubLiteApp,
    ssoConfigured: ssoPolicy.status === 'required',
    seatCount: seatUsage.total,
    seatsUsed: seatUsage.used,
  };
}

export async function getOrganizationRecommendations(organizationId: string): Promise<{
  plan: 'teams' | 'enterprise';
  checks: ReturnType<typeof buildFeatureAdoptionChecks>;
  recommendations: Recommendation[];
}> {
  const orgRows = await readDb
    .select({ plan: organizations.plan })
    .from(organizations)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
    .limit(1);
  const organization = orgRows[0];
  if (!organization) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
  if (organization.plan !== 'enterprise') {
    return { plan: organization.plan, checks: [], recommendations: [] };
  }

  const [state, dismissedRows] = await Promise.all([
    getRecommendationState(organizationId),
    readDb
      .select({ key: organization_recommendation_dismissals.recommendation_key })
      .from(organization_recommendation_dismissals)
      .where(eq(organization_recommendation_dismissals.owned_by_organization_id, organizationId)),
  ]);

  const dismissed = new Set(dismissedRows.map(row => row.key));
  const recommendations = buildRecommendations(organizationId, state).map(recommendation =>
    dismissed.has(recommendation.key)
      ? { ...recommendation, status: 'dismissed' as const }
      : recommendation
  );
  const checks = buildFeatureAdoptionChecks(organizationId, state);

  return { plan: organization.plan, checks, recommendations };
}

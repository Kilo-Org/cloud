export const MINIMUM_REMAINING_MICRODOLLARS = 5_000_000;
const DEFAULT_WARN_REMAINING_MICRODOLLARS = 10_000_000;
const CLOUD_AGENT_SERVICE_PREFIX = 'cloud-agent-next-';

export type BillingConfig = {
  services: ReadonlySet<string>;
  userIds: ReadonlySet<string>;
  orgIds: ReadonlySet<string>;
  cloudAgentUserIds: ReadonlySet<string>;
  cloudAgentOrgIds: ReadonlySet<string>;
  warnRemainingMicrodollars: number;
  enabled: boolean;
};

export const SHADOW_ONLY_BILLING_CONFIG: BillingConfig = {
  services: new Set(),
  userIds: new Set(),
  orgIds: new Set(),
  cloudAgentUserIds: new Set(),
  cloudAgentOrgIds: new Set(),
  warnRemainingMicrodollars: DEFAULT_WARN_REMAINING_MICRODOLLARS,
  enabled: false,
};

type BillingEnvironment = {
  CONTAINER_BILLING_SERVICES?: string;
  CONTAINER_BILLING_USER_IDS?: string;
  CONTAINER_BILLING_ORG_IDS?: string;
  CONTAINER_BILLING_CLOUD_AGENT_USER_IDS?: string;
  CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS?: string;
  CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS?: string;
};

function parseRequiredAllowlist(value: string | undefined): ReadonlySet<string> | null {
  if (!value) return null;
  const values = value.split(',').map(item => item.trim());
  if (values.some(value => value.length === 0)) return null;
  return new Set(values);
}

function parsePayerAllowlist(value: string | undefined): ReadonlySet<string> | null {
  if (value === undefined) return null;
  if (value === '') return new Set();
  return parseRequiredAllowlist(value);
}

/**
 * Invalid configuration deliberately leaves all usage in shadow mode. Payer
 * lists are independent, so a personal canary does not enable organization billing.
 */
export function billingConfigFromEnv(env: BillingEnvironment): BillingConfig {
  const services = parseRequiredAllowlist(env.CONTAINER_BILLING_SERVICES);
  const userIds = parsePayerAllowlist(env.CONTAINER_BILLING_USER_IDS);
  const orgIds = parsePayerAllowlist(env.CONTAINER_BILLING_ORG_IDS);
  const cloudAgentUserIds = parsePayerAllowlist(env.CONTAINER_BILLING_CLOUD_AGENT_USER_IDS);
  const cloudAgentOrgIds = parsePayerAllowlist(env.CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS);
  const warnRemainingMicrodollars = Number(env.CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS);
  const validThreshold =
    Number.isSafeInteger(warnRemainingMicrodollars) &&
    warnRemainingMicrodollars >= MINIMUM_REMAINING_MICRODOLLARS;
  const gastownEnabled =
    services !== null &&
    userIds !== null &&
    orgIds !== null &&
    (userIds.size > 0 || orgIds.size > 0) &&
    validThreshold;
  const cloudAgentEnabled =
    services !== null &&
    cloudAgentUserIds !== null &&
    cloudAgentOrgIds !== null &&
    (cloudAgentUserIds.size > 0 || cloudAgentOrgIds.size > 0) &&
    validThreshold;
  const cloudAgentListsAreValid = cloudAgentUserIds !== null && cloudAgentOrgIds !== null;
  return {
    services: services ?? SHADOW_ONLY_BILLING_CONFIG.services,
    userIds: userIds ?? SHADOW_ONLY_BILLING_CONFIG.userIds,
    orgIds: orgIds ?? SHADOW_ONLY_BILLING_CONFIG.orgIds,
    cloudAgentUserIds: cloudAgentListsAreValid
      ? cloudAgentUserIds
      : SHADOW_ONLY_BILLING_CONFIG.cloudAgentUserIds,
    cloudAgentOrgIds: cloudAgentListsAreValid
      ? cloudAgentOrgIds
      : SHADOW_ONLY_BILLING_CONFIG.cloudAgentOrgIds,
    warnRemainingMicrodollars: validThreshold
      ? warnRemainingMicrodollars
      : DEFAULT_WARN_REMAINING_MICRODOLLARS,
    enabled: gastownEnabled || cloudAgentEnabled,
  };
}

export function billingModeFor(
  config: BillingConfig,
  service: string,
  subject: { type: 'user' | 'org'; id: string }
): 'shadow' | 'paid' {
  if (!config.enabled || !config.services.has(service)) return 'shadow';
  const payerIds = service.startsWith(CLOUD_AGENT_SERVICE_PREFIX)
    ? subject.type === 'user'
      ? config.cloudAgentUserIds
      : config.cloudAgentOrgIds
    : subject.type === 'user'
      ? config.userIds
      : config.orgIds;
  return payerIds?.has(subject.id) ? 'paid' : 'shadow';
}

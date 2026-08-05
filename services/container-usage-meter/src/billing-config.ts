export const MINIMUM_REMAINING_MICRODOLLARS = 5_000_000;
const DEFAULT_WARN_REMAINING_MICRODOLLARS = 10_000_000;

export type BillingConfig = {
  services: ReadonlySet<string>;
  userIds: ReadonlySet<string>;
  orgIds: ReadonlySet<string>;
  warnRemainingMicrodollars: number;
  enabled: boolean;
};

export const SHADOW_ONLY_BILLING_CONFIG: BillingConfig = {
  services: new Set(),
  userIds: new Set(),
  orgIds: new Set(),
  warnRemainingMicrodollars: DEFAULT_WARN_REMAINING_MICRODOLLARS,
  enabled: false,
};

type BillingEnvironment = {
  CONTAINER_BILLING_SERVICES?: string;
  CONTAINER_BILLING_USER_IDS?: string;
  CONTAINER_BILLING_ORG_IDS?: string;
  CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS?: string;
};

function parseAllowlist(value: string | undefined): ReadonlySet<string> | null {
  if (!value) return null;
  const values = value.split(',').map(item => item.trim());
  if (values.some(value => value.length === 0)) return null;
  return new Set(values);
}

/** Invalid or incomplete configuration deliberately leaves all usage in shadow mode. */
export function billingConfigFromEnv(env: BillingEnvironment): BillingConfig {
  const services = parseAllowlist(env.CONTAINER_BILLING_SERVICES);
  const userIds = parseAllowlist(env.CONTAINER_BILLING_USER_IDS);
  const orgIds = parseAllowlist(env.CONTAINER_BILLING_ORG_IDS);
  const warnRemainingMicrodollars = Number(env.CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS);
  const validThreshold =
    Number.isSafeInteger(warnRemainingMicrodollars) &&
    warnRemainingMicrodollars >= MINIMUM_REMAINING_MICRODOLLARS;
  const enabled = services !== null && userIds !== null && orgIds !== null && validThreshold;
  return {
    services: services ?? SHADOW_ONLY_BILLING_CONFIG.services,
    userIds: userIds ?? SHADOW_ONLY_BILLING_CONFIG.userIds,
    orgIds: orgIds ?? SHADOW_ONLY_BILLING_CONFIG.orgIds,
    warnRemainingMicrodollars: validThreshold
      ? warnRemainingMicrodollars
      : DEFAULT_WARN_REMAINING_MICRODOLLARS,
    enabled,
  };
}

export function billingModeFor(
  config: BillingConfig,
  service: string,
  subject: { type: 'user' | 'org'; id: string }
): 'shadow' | 'paid' {
  if (!config.enabled || !config.services.has(service)) return 'shadow';
  return (subject.type === 'user' ? config.userIds : config.orgIds).has(subject.id)
    ? 'paid'
    : 'shadow';
}

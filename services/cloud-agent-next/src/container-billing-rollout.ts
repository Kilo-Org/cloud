import type { Env } from './types.js';

type BillingIdentity = { userId: string; orgId?: string };

function parseAllowlist(value: string | undefined): ReadonlySet<string> | null {
  if (value === undefined || value === '') return new Set();
  const values = value.split(',').map(item => item.trim());
  if (values.some(item => item.length === 0 || item === '*')) return null;
  return new Set(values);
}

export function isCloudAgentContainerBillingEnabled(
  env: Pick<
    Env,
    | 'CLOUD_AGENT_CONTAINER_BILLING_ENABLED'
    | 'CLOUD_AGENT_CONTAINER_BILLING_USER_IDS'
    | 'CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS'
  >,
  identity: BillingIdentity
): boolean {
  if (env.CLOUD_AGENT_CONTAINER_BILLING_ENABLED !== 'true') return false;
  const userIds = parseAllowlist(env.CLOUD_AGENT_CONTAINER_BILLING_USER_IDS);
  const orgIds = parseAllowlist(env.CLOUD_AGENT_CONTAINER_BILLING_ORG_IDS);
  if (!userIds || !orgIds) return false;
  return identity.orgId ? orgIds.has(identity.orgId) : userIds.has(identity.userId);
}

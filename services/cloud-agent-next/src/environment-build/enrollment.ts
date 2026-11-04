import type { EnvironmentScope } from './reference.js';

export function isEnvironmentSnapshotsEnabled(
  env: { ENVIRONMENT_SNAPSHOT_ORG_IDS?: string },
  owner: EnvironmentScope['owner']
): boolean {
  const orgIds = (env.ENVIRONMENT_SNAPSHOT_ORG_IDS ?? '').split(',').map(id => id.trim());
  return orgIds.includes('*') || (owner.type === 'organization' && orgIds.includes(owner.id));
}

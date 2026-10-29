import type { EnvironmentScope } from './reference.js';

/** Snapshot access is separate from native-container enrollment. No wildcard or personal access. */
export function isEnvironmentSnapshotsEnabled(
  env: { ENVIRONMENT_SNAPSHOT_ORG_IDS?: string },
  owner: EnvironmentScope['owner']
): boolean {
  return (
    owner.type === 'organization' &&
    (env.ENVIRONMENT_SNAPSHOT_ORG_IDS ?? '')
      .split(',')
      .some(id => id.trim() !== '*' && id.trim() === owner.id)
  );
}

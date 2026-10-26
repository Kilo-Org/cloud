import { describe, expect, it } from 'vitest';
import { isEnvironmentSnapshotsEnabled } from './enrollment.js';

describe('snapshot organization enrollment', () => {
  const owner = { type: 'organization', id: 'org-a' } as const;

  it('defaults to disabled and does not accept a wildcard', () => {
    for (const value of [undefined, '', '  ', '*', 'org-ab']) {
      expect(isEnvironmentSnapshotsEnabled({ ENVIRONMENT_SNAPSHOT_ORG_IDS: value }, owner)).toBe(
        false
      );
    }
  });

  it('matches only listed organizations, with whitespace allowed', () => {
    const env = { ENVIRONMENT_SNAPSHOT_ORG_IDS: ' org-b, org-a , ' };
    expect(isEnvironmentSnapshotsEnabled(env, owner)).toBe(true);
    expect(isEnvironmentSnapshotsEnabled(env, { type: 'organization', id: 'org-c' })).toBe(false);
    expect(isEnvironmentSnapshotsEnabled(env, { type: 'user', id: owner.id })).toBe(false);
  });
});

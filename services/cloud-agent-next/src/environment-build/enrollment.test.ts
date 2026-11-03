import { describe, expect, it } from 'vitest';
import { isEnvironmentSnapshotsEnabled } from './enrollment.js';

describe('snapshot enrollment', () => {
  const owner = { type: 'organization', id: 'org-a' } as const;

  it('defaults to disabled and requires an exact organization match', () => {
    for (const value of [undefined, '', '  ', 'org-ab', 'org-*']) {
      expect(isEnvironmentSnapshotsEnabled({ ENVIRONMENT_SNAPSHOT_ORG_IDS: value }, owner)).toBe(
        false
      );
    }
  });

  it.each(['*', ' * ', 'org-b, *, org-a , '])(
    'enrolls every organization and personal account with a wildcard: %s',
    value => {
      const env = { ENVIRONMENT_SNAPSHOT_ORG_IDS: value };
      expect(isEnvironmentSnapshotsEnabled(env, owner)).toBe(true);
      expect(isEnvironmentSnapshotsEnabled(env, { type: 'organization', id: 'org-c' })).toBe(true);
      expect(isEnvironmentSnapshotsEnabled(env, { type: 'user', id: 'user-a' })).toBe(true);
    }
  );

  it('matches only listed organizations, with whitespace allowed', () => {
    const env = { ENVIRONMENT_SNAPSHOT_ORG_IDS: ' org-b, org-a , ' };
    expect(isEnvironmentSnapshotsEnabled(env, owner)).toBe(true);
    expect(isEnvironmentSnapshotsEnabled(env, { type: 'organization', id: 'org-c' })).toBe(false);
    expect(isEnvironmentSnapshotsEnabled(env, { type: 'user', id: owner.id })).toBe(false);
  });
});

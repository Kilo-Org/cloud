import { describe, expect, it } from '@jest/globals';
import { describeEnvironmentProfileImpact } from './environment-profile-impact';

describe('environment profile impact', () => {
  const base = {
    id: 'base',
    name: 'Repository profile',
    vars: [{ key: 'SHARED', value: 'private' }, { key: 'BASE_ONLY' }],
  };
  const top = {
    id: 'top',
    name: 'Personal profile',
    vars: [{ key: 'SHARED', value: 'private-top' }],
  };

  it('names the winning profile for each overridden variable without exposing values', () => {
    expect(
      describeEnvironmentProfileImpact([base, top], ['SHARED', 'BASE_ONLY', 'ENV_ONLY'])
    ).toEqual({
      overrides: [
        { key: 'SHARED', profileName: 'Personal profile' },
        { key: 'BASE_ONLY', profileName: 'Repository profile' },
      ],
    });
  });

  it('reports nothing for profiles without overlapping variables', () => {
    expect(describeEnvironmentProfileImpact([{ ...base, vars: [] }], ['ENV_ONLY'])).toEqual({
      overrides: [],
    });
  });
});

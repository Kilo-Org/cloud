import { describe, expect, it } from '@jest/globals';
import { describeEnvironmentProfileImpact } from './environment-profile-impact';

describe('environment profile impact', () => {
  const base = {
    id: 'base',
    name: 'Repository profile',
    commands: ['pnpm install'],
    vars: [{ key: 'SHARED', value: 'private' }, { key: 'BASE_ONLY' }],
  };
  const top = {
    id: 'top',
    name: 'Personal profile',
    commands: ['echo prepare'],
    vars: [{ key: 'SHARED', value: 'private-top' }],
  };

  it('warns about suppressed setup even for an environment with no variables or scripts', () => {
    expect(describeEnvironmentProfileImpact([base, top], [])).toEqual({
      commandProfiles: ['Repository profile', 'Personal profile'],
      overrides: [],
    });
  });

  it('names the winning profile for each overridden variable without exposing values', () => {
    expect(
      describeEnvironmentProfileImpact([base, top], ['SHARED', 'BASE_ONLY', 'ENV_ONLY'])
    ).toEqual({
      commandProfiles: ['Repository profile', 'Personal profile'],
      overrides: [
        { key: 'SHARED', profileName: 'Personal profile' },
        { key: 'BASE_ONLY', profileName: 'Repository profile' },
      ],
    });
  });

  it('does not show a warning for profiles with no setup or overlapping variables', () => {
    expect(
      describeEnvironmentProfileImpact([{ ...base, commands: [], vars: [] }], ['ENV_ONLY'])
    ).toEqual({ commandProfiles: [], overrides: [] });
  });
});

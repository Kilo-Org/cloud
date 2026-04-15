import {
  providerSelectionTestUtils,
  selectOrgKiloClawProvider,
  selectPersonalKiloClawProvider,
} from './provider-selection';

const enabledNorthflankConfig = {
  provider: 'northflank',
  enabled: true,
  personalTrafficPercent: 100,
  organizationTrafficPercent: 100,
} as const;

const orgBase = {
  organizationId: 'org-1',
  userId: 'user-1',
  northflankConfig: enabledNorthflankConfig,
};

const personalBase = {
  userId: 'user-1',
  northflankConfig: enabledNorthflankConfig,
};

describe('KiloClaw provider selection', () => {
  it('selects fly when Northflank is disabled or set to zero percent', () => {
    expect(
      selectOrgKiloClawProvider({
        ...orgBase,
        northflankConfig: {
          ...enabledNorthflankConfig,
          enabled: false,
        },
      })
    ).toBe('fly');

    expect(
      selectPersonalKiloClawProvider({
        ...personalBase,
        northflankConfig: {
          ...enabledNorthflankConfig,
          personalTrafficPercent: 0,
        },
      })
    ).toBe('fly');
  });

  it('selects northflank when enabled at 100 percent', () => {
    expect(selectOrgKiloClawProvider(orgBase)).toBe('northflank');
    expect(selectPersonalKiloClawProvider(personalBase)).toBe('northflank');
  });

  it('uses explicit deterministic rollout keys', () => {
    const orgBucket = providerSelectionTestUtils.rolloutBucket('org:org-1:user:user-1');
    const personalBucket = providerSelectionTestUtils.rolloutBucket('personal:user:user-1');

    expect(
      selectOrgKiloClawProvider({
        ...orgBase,
        northflankConfig: {
          ...enabledNorthflankConfig,
          organizationTrafficPercent: orgBucket + 1,
        },
      })
    ).toBe('northflank');

    expect(
      selectPersonalKiloClawProvider({
        ...personalBase,
        northflankConfig: {
          ...enabledNorthflankConfig,
          personalTrafficPercent: personalBucket + 1,
        },
      })
    ).toBe('northflank');
  });
});

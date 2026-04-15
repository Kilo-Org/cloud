import {
  providerSelectionTestUtils,
  selectOrgKiloClawProvider,
  selectPersonalKiloClawProvider,
} from './provider-selection';

const orgBase = {
  organizationId: 'org-1',
  userId: 'user-1',
  rolloutAvailable: true,
};

const personalBase = {
  userId: 'user-1',
  personalRolloutConfig: {
    rolloutAvailable: true,
    northflankEnabled: true,
    northflankTrafficPercent: 100,
  },
};

describe('KiloClaw provider selection', () => {
  it('selects fly when rollout is unavailable', () => {
    expect(
      selectOrgKiloClawProvider({
        ...orgBase,
        rolloutAvailable: false,
        organizationSettings: {
          kiloclaw_northflank_enabled: true,
          kiloclaw_northflank_traffic_percent: 100,
        },
      })
    ).toBe('fly');

    expect(
      selectPersonalKiloClawProvider({
        ...personalBase,
        personalRolloutConfig: {
          rolloutAvailable: false,
          northflankEnabled: true,
          northflankTrafficPercent: 100,
        },
      })
    ).toBe('fly');
  });

  it('selects fly when Northflank is disabled or set to zero percent', () => {
    expect(
      selectOrgKiloClawProvider({
        ...orgBase,
        organizationSettings: {
          kiloclaw_northflank_enabled: false,
          kiloclaw_northflank_traffic_percent: 100,
        },
      })
    ).toBe('fly');

    expect(
      selectPersonalKiloClawProvider({
        ...personalBase,
        personalRolloutConfig: {
          rolloutAvailable: true,
          northflankEnabled: true,
          northflankTrafficPercent: 0,
        },
      })
    ).toBe('fly');
  });

  it('selects northflank when enabled at 100 percent', () => {
    expect(
      selectOrgKiloClawProvider({
        ...orgBase,
        organizationSettings: {
          kiloclaw_northflank_enabled: true,
          kiloclaw_northflank_traffic_percent: 100,
        },
      })
    ).toBe('northflank');

    expect(selectPersonalKiloClawProvider(personalBase)).toBe('northflank');
  });

  it('uses explicit deterministic rollout keys', () => {
    const orgBucket = providerSelectionTestUtils.rolloutBucket('org:org-1:user:user-1');
    const personalBucket = providerSelectionTestUtils.rolloutBucket('personal:user:user-1');

    expect(
      selectOrgKiloClawProvider({
        ...orgBase,
        organizationSettings: {
          kiloclaw_northflank_enabled: true,
          kiloclaw_northflank_traffic_percent: orgBucket + 1,
        },
      })
    ).toBe('northflank');

    expect(
      selectPersonalKiloClawProvider({
        ...personalBase,
        personalRolloutConfig: {
          rolloutAvailable: true,
          northflankEnabled: true,
          northflankTrafficPercent: personalBucket + 1,
        },
      })
    ).toBe('northflank');
  });
});

import { getPersonalKiloClawProviderRolloutConfig } from './provider-rollout-config';

const envKeys = [
  'KILOCLAW_NORTHFLANK_ROLLOUT_AVAILABLE',
  'KILOCLAW_PERSONAL_NORTHFLANK_ENABLED',
  'KILOCLAW_PERSONAL_NORTHFLANK_TRAFFIC_PERCENT',
];

describe('personal KiloClaw provider rollout config', () => {
  const previousEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of envKeys) {
      previousEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      const value = previousEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    previousEnv.clear();
  });

  it('defaults to disabled at zero percent', () => {
    expect(getPersonalKiloClawProviderRolloutConfig()).toEqual({
      rolloutAvailable: false,
      northflankEnabled: false,
      northflankTrafficPercent: 0,
    });
  });

  it('parses enabled rollout config', () => {
    process.env.KILOCLAW_NORTHFLANK_ROLLOUT_AVAILABLE = 'true';
    process.env.KILOCLAW_PERSONAL_NORTHFLANK_ENABLED = '1';
    process.env.KILOCLAW_PERSONAL_NORTHFLANK_TRAFFIC_PERCENT = '10';

    expect(getPersonalKiloClawProviderRolloutConfig()).toEqual({
      rolloutAvailable: true,
      northflankEnabled: true,
      northflankTrafficPercent: 10,
    });
  });

  it('rejects invalid traffic percentages', () => {
    process.env.KILOCLAW_PERSONAL_NORTHFLANK_TRAFFIC_PERCENT = '101';

    expect(() => getPersonalKiloClawProviderRolloutConfig()).toThrow(
      'KILOCLAW_PERSONAL_NORTHFLANK_TRAFFIC_PERCENT must be an integer between 0 and 100'
    );
  });
});

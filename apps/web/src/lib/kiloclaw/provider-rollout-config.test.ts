import { cleanupDbForTest } from '@/lib/drizzle';
import {
  getKiloClawProviderRolloutConfig,
  updateKiloClawProviderRolloutConfig,
} from './provider-rollout-config';
import { KiloClawProvider } from '@kilocode/db/schema-types';

describe('KiloClaw provider rollout config', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('defaults Northflank to disabled at zero percent', async () => {
    await expect(getKiloClawProviderRolloutConfig(KiloClawProvider.Northflank)).resolves.toEqual({
      provider: KiloClawProvider.Northflank,
      enabled: false,
      personalTrafficPercent: 0,
      organizationTrafficPercent: 0,
    });
  });

  it('upserts and reads rollout config', async () => {
    await updateKiloClawProviderRolloutConfig({
      provider: KiloClawProvider.Northflank,
      enabled: true,
      personalTrafficPercent: 10,
      organizationTrafficPercent: 25,
    });

    await expect(getKiloClawProviderRolloutConfig(KiloClawProvider.Northflank)).resolves.toEqual({
      provider: KiloClawProvider.Northflank,
      enabled: true,
      personalTrafficPercent: 10,
      organizationTrafficPercent: 25,
    });
  });
});

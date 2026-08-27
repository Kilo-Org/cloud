import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('rig integration identity', () => {
  it('persists independent integration identities per rig', async () => {
    const town = env.TOWN.get(env.TOWN.idFromName(`rig-identity-${crypto.randomUUID()}`));
    const base = {
      townId: 'town-1',
      gitUrl: 'https://github.com/acme/repo.git',
      defaultBranch: 'main',
      userId: 'user-1',
    };

    await town.configureRig({
      ...base,
      rigId: 'rig-one',
      platformIntegrationId: 'integration-one',
    });
    await town.configureRig({
      ...base,
      rigId: 'rig-two',
      platformIntegrationId: 'integration-two',
    });

    expect(await town.getRigConfig('rig-one')).toMatchObject({
      rigId: 'rig-one',
      platformIntegrationId: 'integration-one',
    });
    expect(await town.getRigConfig('rig-two')).toMatchObject({
      rigId: 'rig-two',
      platformIntegrationId: 'integration-two',
    });
  });
});

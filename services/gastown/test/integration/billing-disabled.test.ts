import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Gastown billing feature flags', () => {
  it('reports neither metering nor enforcement without the meter binding', async () => {
    const townId = `billing-disabled-${crypto.randomUUID()}`;
    const town = env.TOWN.get(env.TOWN.idFromName(townId));
    await town.setTownId(townId);

    await expect(town.getBillingStatus()).resolves.toEqual({
      enabled: false,
      enforcing: false,
      state: 'idle',
      runPolicy: 'automatic',
    });
    await expect(town.getAlarmStatus()).resolves.toMatchObject({
      billing: { enabled: false, enforcing: false, state: 'idle', runPolicy: 'automatic' },
    });
  });

  it('persists a user-controlled automatic-start pause', async () => {
    const townId = `billing-pause-${crypto.randomUUID()}`;
    const town = env.TOWN.get(env.TOWN.idFromName(townId));
    await town.setTownId(townId);

    await expect(town.setContainerRunPolicy('paused_by_user')).resolves.toMatchObject({
      runPolicy: 'paused_by_user',
    });
    await expect(town.getBillingStatus()).resolves.toMatchObject({
      runPolicy: 'paused_by_user',
    });
    await expect(town.setContainerRunPolicy('automatic')).resolves.toMatchObject({
      runPolicy: 'automatic',
    });
  });
});

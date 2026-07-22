import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('Gastown billing feature flag', () => {
  it('keeps billing disabled in both dedicated and alarm status', async () => {
    const townId = `billing-disabled-${crypto.randomUUID()}`;
    const town = env.TOWN.get(env.TOWN.idFromName(townId));
    await town.setTownId(townId);

    await expect(town.getBillingStatus()).resolves.toEqual({ enabled: false, state: 'idle' });
    await expect(town.getAlarmStatus()).resolves.toMatchObject({
      billing: { enabled: false, state: 'idle' },
    });
  });
});

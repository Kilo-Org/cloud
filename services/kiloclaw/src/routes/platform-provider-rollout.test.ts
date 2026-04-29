import { describe, expect, it, vi } from 'vitest';
import { platform } from './platform';
import { PROVIDER_ROLLOUT_KV_KEY } from '../providers/rollout';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
  waitUntil: (promise: Promise<unknown>) => promise,
}));

function makeEnv(initial?: string) {
  const store = new Map<string, string>();
  if (initial) store.set(PROVIDER_ROLLOUT_KV_KEY, initial);

  return {
    KV_CLAW_CACHE: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
    },
  } as never;
}

describe('provider rollout platform routes', () => {
  it('returns default zero-percent Northflank rollout config', async () => {
    const response = await platform.request('/providers/rollout', undefined, makeEnv());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      rollout: {
        northflank: {
          personalTrafficPercent: 0,
          organizationTrafficPercent: 0,
          enabledOrganizationIds: [],
        },
      },
      availability: { northflank: true },
      source: 'default',
    });
  });

  it('stores rollout percentages and org opt-ins in KV', async () => {
    const env = makeEnv();
    const response = await platform.request(
      '/providers/rollout',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          northflank: {
            personalTrafficPercent: 10,
            organizationTrafficPercent: 25,
            enabledOrganizationIds: ['550e8400-e29b-41d4-a716-446655440001'],
          },
        }),
      },
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      rollout: {
        northflank: {
          personalTrafficPercent: 10,
          organizationTrafficPercent: 25,
          enabledOrganizationIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      },
      availability: { northflank: true },
    });
  });

  it('rejects invalid rollout percentages', async () => {
    const response = await platform.request(
      '/providers/rollout',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          northflank: {
            personalTrafficPercent: 101,
            organizationTrafficPercent: 100,
            enabledOrganizationIds: [],
          },
        }),
      },
      makeEnv()
    );

    expect(response.status).toBe(400);
  });
});

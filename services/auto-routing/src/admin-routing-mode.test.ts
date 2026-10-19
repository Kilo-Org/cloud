import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { getRoutingModeHandler } from './admin-routing-mode';
import type { HonoEnv } from './hono-env';

function readMode(getMode: () => Promise<string | null>) {
  const app = new Hono<HonoEnv>();
  app.get('/mode', getRoutingModeHandler);
  const env = {
    AUTO_ROUTING_MODE_CONFIG: {
      idFromName: (name: string) => name,
      get: () => ({ getMode }),
    },
  } as unknown as Env;
  return app.request('/mode?ownerType=user&ownerId=fixture-owner', {}, env);
}

describe('platform mode settings reads', () => {
  it('returns the saved selection after a transient read failure', async () => {
    const getMode = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('temporary storage failure'))
      .mockResolvedValue('best_accuracy');
    const response = await readMode(getMode);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ configuredMode: 'best_accuracy' });
  });

  it('reports unavailable storage instead of pretending the saved selection was cleared', async () => {
    const getMode = vi
      .fn<() => Promise<string | null>>()
      .mockRejectedValue(new Error('storage unavailable'));
    const response = await readMode(getMode);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.not.toHaveProperty('configuredMode');
    expect(getMode).toHaveBeenCalledTimes(2);
  });

  it('distinguishes an unconfigured owner from a storage failure', async () => {
    const response = await readMode(async () => null);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toHaveProperty('configuredMode', null);
  });
});

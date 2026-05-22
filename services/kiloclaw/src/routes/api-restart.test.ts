import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../types';
import { api } from './api';

type RestartFailure = {
  success: false;
  error: string;
};

function createRestartHarness(result: RestartFailure) {
  const restartMachine = vi.fn().mockResolvedValue(result);
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('userId', 'user-1');
    await next();
  });
  app.route('/api', api);

  return {
    app,
    env: {
      KILOCLAW_INSTANCE: {
        idFromName: (id: string) => id,
        get: () => ({ restartMachine }),
      },
    } as never,
    restartMachine,
  };
}

async function postRestart(path: string, result: RestartFailure) {
  const { app, env, restartMachine } = createRestartHarness(result);
  const response = await app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    },
    env
  );

  return { response, restartMachine };
}

describe('admin machine restart route failures', () => {
  it('returns 404 when no machine runtime exists', async () => {
    const { response, restartMachine } = await postRestart('/api/admin/machine/restart', {
      success: false,
      error: 'No machine exists',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: 'No machine exists' });
    expect(restartMachine).toHaveBeenCalledWith(undefined);
  });

  it('keeps the backward-compatible restart alias on the same 404 contract', async () => {
    const { response, restartMachine } = await postRestart('/api/admin/gateway/restart', {
      success: false,
      error: 'No machine exists',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: 'No machine exists' });
    expect(restartMachine).toHaveBeenCalledWith(undefined);
  });

  it('keeps unexpected restart failures on a 500 response', async () => {
    const { response } = await postRestart('/api/admin/machine/restart', {
      success: false,
      error: 'Fly control plane unavailable',
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      success: false,
      error: 'Fly control plane unavailable',
    });
  });
});

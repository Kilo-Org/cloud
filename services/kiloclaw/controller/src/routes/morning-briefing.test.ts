import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { registerMorningBriefingRoutes } from './morning-briefing';
import type { Supervisor } from '../supervisor';

function createRunningSupervisor(): Supervisor {
  const state = 'running' as const;
  return {
    start: vi.fn(async () => true),
    stop: vi.fn(async () => true),
    restart: vi.fn(async () => true),
    shutdown: vi.fn(async () => undefined),
    signal: vi.fn(() => true),
    getState: vi.fn(() => state),
    getStats: vi.fn(() => ({
      state,
      pid: 1,
      uptime: 1,
      restarts: 0,
      lastExit: null,
    })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('morning briefing controller routes', () => {
  it('enforces bearer auth before proxying', async () => {
    const app = new Hono();
    registerMorningBriefingRoutes(app, createRunningSupervisor(), 'expected-token');

    const response = await app.request('/_kilo/morning-briefing/status');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('forwards expected gateway token to proxied route', async () => {
    const app = new Hono();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    registerMorningBriefingRoutes(app, createRunningSupervisor(), 'expected-token');

    const response = await app.request('/_kilo/morning-briefing/enable', {
      method: 'POST',
      headers: {
        authorization: 'Bearer expected-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ cron: '0 7 * * *', timezone: 'America/Chicago' }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/plugins/kiloclaw-morning-briefing/enable',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer expected-token',
          'content-type': 'application/json',
        }),
      })
    );
  });
});

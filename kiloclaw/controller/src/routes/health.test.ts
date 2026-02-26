import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { registerHealthRoute } from './health';
import type { Supervisor } from '../supervisor';

function createMockSupervisor(): Supervisor {
  return {
    start: async () => true,
    stop: async () => true,
    restart: async () => true,
    shutdown: async () => undefined,
    getState: () => 'running',
    getStats: () => ({
      state: 'running',
      pid: 42,
      uptime: 123,
      restarts: 2,
      lastExit: null,
    }),
  };
}

describe('GET /_kilo/health', () => {
  it('returns 200 with minimal payload', async () => {
    const app = new Hono();
    registerHealthRoute(app, createMockSupervisor());

    const resp = await app.request('/_kilo/health');
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /health (compatibility alias)', () => {
  it('returns 200 with minimal payload', async () => {
    const app = new Hono();
    registerHealthRoute(app, createMockSupervisor());

    const resp = await app.request('/health');
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ status: 'ok' });
  });
});

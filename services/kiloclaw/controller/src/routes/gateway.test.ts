import os from 'node:os';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { loadFields, registerGatewayRoutes } from './gateway';
import type { Supervisor } from '../supervisor';

function createMockSupervisor(): Supervisor {
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
      pid: 100,
      uptime: 50,
      restarts: 3,
      lastExit: { code: 1, signal: null, at: '2026-02-20T00:00:00.000Z' },
    })),
  };
}

function authHeaders(token = 'test-token'): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

type RuntimeEnvSnapshot = {
  FLY_MACHINE_ID: string | undefined;
  KILOCLAW_RUNTIME_PROVIDER: string | undefined;
  KILOCLAW_MACHINE_CPU_KIND: string | undefined;
};

function snapshotRuntimeEnv(): RuntimeEnvSnapshot {
  return {
    FLY_MACHINE_ID: process.env.FLY_MACHINE_ID,
    KILOCLAW_RUNTIME_PROVIDER: process.env.KILOCLAW_RUNTIME_PROVIDER,
    KILOCLAW_MACHINE_CPU_KIND: process.env.KILOCLAW_MACHINE_CPU_KIND,
  };
}

function restoreRuntimeEnv(snapshot: RuntimeEnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

let runtimeEnvSnapshot: RuntimeEnvSnapshot;

beforeEach(() => {
  runtimeEnvSnapshot = snapshotRuntimeEnv();
});

afterEach(() => {
  restoreRuntimeEnv(runtimeEnvSnapshot);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('/_kilo/gateway routes', () => {
  it('enforces bearer auth on GET /_kilo/gateway/status', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor();
    registerGatewayRoutes(app, supervisor, 'test-token');

    const noAuth = await app.request('/_kilo/gateway/status');
    expect(noAuth.status).toBe(401);

    const wrongAuth = await app.request('/_kilo/gateway/status', {
      headers: authHeaders('bad-token'),
    });
    expect(wrongAuth.status).toBe(401);

    const ok = await app.request('/_kilo/gateway/status', { headers: authHeaders() });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      state: 'running',
      pid: 100,
      uptime: 50,
      restarts: 3,
      lastExit: { code: 1, signal: null, at: '2026-02-20T00:00:00.000Z' },
    });
  });

  it('enforces bearer auth on POST /_kilo/gateway/restart', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor();
    registerGatewayRoutes(app, supervisor, 'test-token');

    const noAuth = await app.request('/_kilo/gateway/restart', { method: 'POST' });
    expect(noAuth.status).toBe(401);

    const wrongAuth = await app.request('/_kilo/gateway/restart', {
      method: 'POST',
      headers: authHeaders('wrong'),
    });
    expect(wrongAuth.status).toBe(401);

    const ok = await app.request('/_kilo/gateway/restart', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
  });

  it('returns 401 for /_kilo/gateway/status before catch-all proxy route', async () => {
    const app = new Hono();
    const supervisor = createMockSupervisor();
    registerGatewayRoutes(app, supervisor, 'test-token');
    app.all('*', c => c.json({ proxied: true }));

    const resp = await app.request('/_kilo/gateway/status');
    expect(resp.status).toBe(401);
    expect(await resp.json()).toEqual({ error: 'Unauthorized' });
  });

  it('marks high load as unsettled on Fly shared CPU instances', () => {
    vi.spyOn(os, 'loadavg').mockReturnValue([0.5, 0.2, 0.1]);

    expect(
      loadFields({
        KILOCLAW_RUNTIME_PROVIDER: 'fly',
        KILOCLAW_MACHINE_CPU_KIND: 'shared',
      })
    ).toEqual({
      loadAverage: [0.5, 0.2, 0.1],
      settled: false,
    });
  });

  it('does not wait for load settling on Fly performance CPU instances', () => {
    vi.spyOn(os, 'loadavg').mockReturnValue([0.5, 0.2, 0.1]);

    expect(
      loadFields({
        KILOCLAW_RUNTIME_PROVIDER: 'fly',
        KILOCLAW_MACHINE_CPU_KIND: 'performance',
      })
    ).toEqual({
      loadAverage: [0.5, 0.2, 0.1],
      settled: true,
    });
  });

  it('does not wait for load settling on docker-local instances', () => {
    vi.spyOn(os, 'loadavg').mockReturnValue([0.5, 0.2, 0.1]);

    expect(
      loadFields({
        KILOCLAW_RUNTIME_PROVIDER: 'docker-local',
        KILOCLAW_MACHINE_CPU_KIND: 'shared',
      })
    ).toEqual({
      loadAverage: [0.5, 0.2, 0.1],
      settled: true,
    });
  });
});

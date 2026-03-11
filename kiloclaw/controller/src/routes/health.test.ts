import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { registerHealthRoute, parseOpenclawVersion } from './health';
import type { Supervisor } from '../supervisor';

const MOCK_STATS = {
  state: 'running' as const,
  pid: 42,
  uptime: 123,
  restarts: 2,
  lastExit: null,
};

function createMockSupervisor(): Supervisor {
  return {
    start: async () => true,
    stop: async () => true,
    restart: async () => true,
    shutdown: async () => undefined,
    signal: () => true,
    getState: () => 'running',
    getStats: () => MOCK_STATS,
  };
}

describe('parseOpenclawVersion', () => {
  it('parses full output with commit hash', () => {
    expect(parseOpenclawVersion('OpenClaw 2026.3.8 (3caab92)')).toEqual({
      version: '2026.3.8',
      commit: '3caab92',
    });
  });

  it('parses output without commit hash', () => {
    expect(parseOpenclawVersion('OpenClaw 2026.3.8')).toEqual({
      version: '2026.3.8',
      commit: null,
    });
  });

  it('parses bare calver', () => {
    expect(parseOpenclawVersion('2026.3.8')).toEqual({
      version: '2026.3.8',
      commit: null,
    });
  });

  it('returns null version for unrecognised output', () => {
    expect(parseOpenclawVersion('something unexpected')).toEqual({
      version: null,
      commit: null,
    });
  });

  it('returns null version for empty string', () => {
    expect(parseOpenclawVersion('')).toEqual({
      version: null,
      commit: null,
    });
  });
});

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

describe('GET /_kilo/version', () => {
  it('returns version and gateway stats when authenticated', async () => {
    const app = new Hono();
    registerHealthRoute(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/version', {
      headers: { Authorization: 'Bearer test-token' },
    });
    expect(resp.status).toBe(200);

    const body = (await resp.json()) as {
      version: string;
      commit: string;
      gateway: typeof MOCK_STATS;
    };
    expect(body.version).toBe('dev');
    expect(body.commit).toBe('unknown');
    expect(body.gateway).toEqual(MOCK_STATS);
  });

  it('rejects unauthenticated requests when token is configured', async () => {
    const app = new Hono();
    registerHealthRoute(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/version');
    expect(resp.status).toBe(401);
  });

  it('rejects wrong token', async () => {
    const app = new Hono();
    registerHealthRoute(app, createMockSupervisor(), 'test-token');

    const resp = await app.request('/_kilo/version', {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    expect(resp.status).toBe(401);
  });

  it('allows unauthenticated access when no token configured', async () => {
    const app = new Hono();
    registerHealthRoute(app, createMockSupervisor());

    const resp = await app.request('/_kilo/version');
    expect(resp.status).toBe(200);

    const body = (await resp.json()) as { version: string; commit: string };
    expect(body.version).toBe('dev');
    expect(body.commit).toBe('unknown');
  });
});

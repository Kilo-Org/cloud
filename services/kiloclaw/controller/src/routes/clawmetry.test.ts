import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import {
  registerClawmetryRoutes,
  CLAWMETRY_DASHBOARD_URL_PATH,
  CLAWMETRY_CONFIG_PATH,
} from './clawmetry';

const TOKEN = 'test-token';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function makeApp(deps: Parameters<typeof registerClawmetryRoutes>[2]): Hono {
  const app = new Hono();
  registerClawmetryRoutes(app, TOKEN, deps);
  return app;
}

// ── auth ──────────────────────────────────────────────────────────────────

describe('clawmetry routes — auth', () => {
  it('GET /_kilo/clawmetry-dashboard-url rejects missing bearer', async () => {
    const app = makeApp({ existsSync: () => true, readFileSync: () => 'http://x' });
    const res = await app.request('/_kilo/clawmetry-dashboard-url');
    expect(res.status).toBe(401);
  });

  it('GET rejects wrong bearer', async () => {
    const app = makeApp({ existsSync: () => true, readFileSync: () => 'http://x' });
    const res = await app.request('/_kilo/clawmetry-dashboard-url', {
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
  });

  it('POST /_kilo/clawmetry-start-sync rejects missing bearer', async () => {
    const app = makeApp({});
    const res = await app.request('/_kilo/clawmetry-start-sync', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

// ── GET dashboard-url ──────────────────────────────────────────────────────

describe('GET /_kilo/clawmetry-dashboard-url', () => {
  it('returns the URL from disk', async () => {
    const app = makeApp({
      existsSync: p => p === CLAWMETRY_DASHBOARD_URL_PATH,
      readFileSync: p => {
        if (p === CLAWMETRY_DASHBOARD_URL_PATH) {
          return 'https://app.clawmetry.com/cloud#key=abc&node=fly-machine-1\n';
        }
        return '';
      },
    });
    const res = await app.request('/_kilo/clawmetry-dashboard-url', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    expect(body.url).toBe('https://app.clawmetry.com/cloud#key=abc&node=fly-machine-1');
  });

  it('returns 404 when bootstrap has not run (file missing)', async () => {
    const app = makeApp({ existsSync: () => false });
    const res = await app.request('/_kilo/clawmetry-dashboard-url', { headers: AUTH });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('not found');
  });

  it('returns 500 when file is empty', async () => {
    const app = makeApp({
      existsSync: () => true,
      readFileSync: () => '   \n',
    });
    const res = await app.request('/_kilo/clawmetry-dashboard-url', { headers: AUTH });
    expect(res.status).toBe(500);
  });

  it('returns 500 when readFileSync throws', async () => {
    const app = makeApp({
      existsSync: () => true,
      readFileSync: () => {
        throw new Error('disk error');
      },
    });
    const res = await app.request('/_kilo/clawmetry-dashboard-url', { headers: AUTH });
    expect(res.status).toBe(500);
  });
});

// ── POST start-sync ────────────────────────────────────────────────────────

describe('POST /_kilo/clawmetry-start-sync', () => {
  it('reads api_key from config and POSTs to ClawMetry intent-start', async () => {
    const intentCalls: string[] = [];
    const app = makeApp({
      existsSync: p => p === CLAWMETRY_CONFIG_PATH,
      readFileSync: p => {
        if (p === CLAWMETRY_CONFIG_PATH) {
          return JSON.stringify({ api_key: 'cm_abc123', node_id: 'agent-vivek-fly' });
        }
        return '';
      },
      intentStart: async apiKey => {
        intentCalls.push(apiKey);
        return { ok: true, alreadyStarted: false };
      },
    });

    const res = await app.request('/_kilo/clawmetry-start-sync', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyStarted: false });
    expect(intentCalls).toEqual(['cm_abc123']);
  });

  it('returns alreadyStarted:true when intent was already set on a prior call', async () => {
    const app = makeApp({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ api_key: 'cm_abc123' }),
      intentStart: async () => ({ ok: true, alreadyStarted: true }),
    });

    const res = await app.request('/_kilo/clawmetry-start-sync', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyStarted: true });
  });

  it('returns 404 when bootstrap config is missing (provisioning never ran)', async () => {
    const app = makeApp({
      existsSync: () => false,
      intentStart: vi.fn(),
    });
    const res = await app.request('/_kilo/clawmetry-start-sync', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it('returns 500 when config exists but is missing api_key', async () => {
    const app = makeApp({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ node_id: 'x' }),
      intentStart: vi.fn(),
    });
    const res = await app.request('/_kilo/clawmetry-start-sync', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(500);
  });

  it('returns 502 when intent-start upstream fails', async () => {
    const app = makeApp({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ api_key: 'cm_abc123' }),
      intentStart: async () => {
        throw new Error('cloud unreachable');
      },
    });
    const res = await app.request('/_kilo/clawmetry-start-sync', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(502);
  });
});

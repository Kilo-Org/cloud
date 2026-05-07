import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { registerClawmetryRoutes, CLAWMETRY_DASHBOARD_URL_PATH } from './clawmetry';

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
  it('spawns the daemon and returns { ok: true, alreadyRunning: false }', async () => {
    const spawnCalls: { cmd: string; args: string[] }[] = [];
    const fakeChild = {
      unref: vi.fn(),
    };
    const app = makeApp({
      isAlreadyRunning: () => false,
      spawn: ((cmd: string, args: string[]) => {
        spawnCalls.push({ cmd, args });
        return fakeChild as unknown as ReturnType<typeof import('node:child_process').spawn>;
      }) as typeof import('node:child_process').spawn,
    });

    const res = await app.request('/_kilo/clawmetry-start-sync', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyRunning: false });
    expect(spawnCalls).toEqual([
      { cmd: '/root/.clawmetry/bin/python3', args: ['-m', 'clawmetry.sync'] },
    ]);
    expect(fakeChild.unref).toHaveBeenCalledOnce();
  });

  it('is idempotent — returns alreadyRunning:true when daemon exists', async () => {
    const spawnSpy = vi.fn();
    const app = makeApp({
      isAlreadyRunning: () => true,
      spawn: spawnSpy as unknown as typeof import('node:child_process').spawn,
    });

    const res = await app.request('/_kilo/clawmetry-start-sync', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, alreadyRunning: true });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('returns 500 when spawn throws', async () => {
    const app = makeApp({
      isAlreadyRunning: () => false,
      spawn: (() => {
        throw new Error('ENOENT');
      }) as typeof import('node:child_process').spawn,
    });
    const res = await app.request('/_kilo/clawmetry-start-sync', {
      method: 'POST',
      headers: AUTH,
    });
    expect(res.status).toBe(500);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { spawn } from 'node:child_process';
import {
  registerKiloCliRunRoutes,
  buildRunPrompt,
  _getActiveRun,
  _resetActiveRun,
} from './kilo-cli-run';

// Mock child_process.spawn
const mockOn = vi.fn();
const mockOnce = vi.fn();
const mockKill = vi.fn();
const mockStdoutOn = vi.fn();
const mockStderrOn = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => ({
    pid: 12345,
    stdout: { on: mockStdoutOn },
    stderr: { on: mockStderrOn },
    on: mockOn,
    once: mockOnce,
    kill: mockKill,
  })),
  execSync: vi.fn(() => '/usr/local/bin/kilo'),
}));

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
  },
}));

function authHeaders(token = 'test-token'): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('buildRunPrompt', () => {
  it('wraps user prompt with system context', () => {
    const result = buildRunPrompt('Fix the Telegram bot');
    expect(result).toContain('Fix the Telegram bot');
    expect(result).toContain('/root/.openclaw/openclaw.json');
    expect(result).toContain('127.0.0.1:3001');
    expect(result).toContain('kill -USR1');
  });

  it('includes key diagnostic paths', () => {
    const result = buildRunPrompt('check config');
    expect(result).toContain('/root/.openclaw/workspace/config/mcporter.json');
    expect(result).toContain('/root/clawd/');
    expect(result).toContain('/_kilo/health');
  });
});

describe('/_kilo/cli-run routes', () => {
  let app: Hono;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    _resetActiveRun();
    app = new Hono();
    registerKiloCliRunRoutes(app, 'test-token');
    // Set env vars needed by the routes
    process.env.KILOCLAW_KILO_CLI = 'true';
    process.env.KILO_API_KEY = 'test-api-key';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── Auth ────────────────────────────────────────────────────────────

  it('rejects requests without auth', async () => {
    const resp = await app.request('/_kilo/cli-run/status', { method: 'GET' });
    expect(resp.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const resp = await app.request('/_kilo/cli-run/status', {
      method: 'GET',
      headers: authHeaders('wrong-token'),
    });
    expect(resp.status).toBe(401);
  });

  // ── GET /_kilo/cli-run/status ───────────────────────────────────────

  it('returns hasRun=false when no run has started', async () => {
    const resp = await app.request('/_kilo/cli-run/status', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.hasRun).toBe(false);
    expect(body.status).toBeNull();
  });

  // ── POST /_kilo/cli-run/start ───────────────────────────────────────

  it('rejects start when KILOCLAW_KILO_CLI is not true', async () => {
    process.env.KILOCLAW_KILO_CLI = 'false';
    const resp = await app.request('/_kilo/cli-run/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ prompt: 'test task' }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error).toContain('not enabled');
  });

  it('rejects start when KILO_API_KEY is missing', async () => {
    delete process.env.KILO_API_KEY;
    const resp = await app.request('/_kilo/cli-run/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ prompt: 'test task' }),
    });
    expect(resp.status).toBe(400);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error).toContain('KILO_API_KEY');
  });

  it('rejects empty prompt', async () => {
    const resp = await app.request('/_kilo/cli-run/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ prompt: '' }),
    });
    expect(resp.status).toBe(400);
  });

  it('rejects invalid JSON body', async () => {
    const resp = await app.request('/_kilo/cli-run/start', {
      method: 'POST',
      headers: authHeaders(),
      body: 'not json',
    });
    expect(resp.status).toBe(400);
  });

  it('starts a run successfully', async () => {
    const resp = await app.request('/_kilo/cli-run/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ prompt: 'fix the bug' }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.startedAt).toBeDefined();

    // RunState stores the original user prompt (for UI display)
    const run = _getActiveRun();
    expect(run).not.toBeNull();
    expect(run?.prompt).toBe('fix the bug');
    expect(run?.status).toBe('running');

    // spawn receives the expanded prompt with system context
    const spawnMock = vi.mocked(spawn);
    const spawnArgs = spawnMock.mock.calls[0][1] as string[];
    expect(spawnArgs[0]).toBe('run');
    expect(spawnArgs[1]).toBe('--auto');
    expect(spawnArgs[2]).toContain('fix the bug');
    expect(spawnArgs[2]).toContain('/root/.openclaw/openclaw.json');
  });

  it('rejects concurrent runs', async () => {
    // Start first run
    await app.request('/_kilo/cli-run/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ prompt: 'first task' }),
    });

    // Try to start second run
    const resp = await app.request('/_kilo/cli-run/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ prompt: 'second task' }),
    });
    expect(resp.status).toBe(409);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.error).toContain('already in progress');
  });

  // ── POST /_kilo/cli-run/cancel ──────────────────────────────────────

  it('returns 404 when cancelling with no active run', async () => {
    const resp = await app.request('/_kilo/cli-run/cancel', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(resp.status).toBe(404);
  });

  it('cancels an active run', async () => {
    // Start a run first
    await app.request('/_kilo/cli-run/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ prompt: 'cancellable task' }),
    });

    const resp = await app.request('/_kilo/cli-run/cancel', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);

    // Verify run is now cancelled
    const run = _getActiveRun();
    expect(run?.status).toBe('cancelled');
    expect(mockKill).toHaveBeenCalledWith('SIGTERM');
  });

  // ── GET /_kilo/cli-run/status (with active run) ────────────────────

  it('returns run status after start', async () => {
    await app.request('/_kilo/cli-run/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ prompt: 'status test' }),
    });

    const resp = await app.request('/_kilo/cli-run/status', {
      method: 'GET',
      headers: authHeaders(),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.hasRun).toBe(true);
    expect(body.status).toBe('running');
    expect(body.prompt).toBe('status test');
    expect(body.startedAt).toBeDefined();
    expect(body.completedAt).toBeNull();
  });
});

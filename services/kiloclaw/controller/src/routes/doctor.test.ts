import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { registerDoctorRoutes, _getActiveRun, _resetActiveRun, _resetStartQueue } from './doctor';

type ChildMock = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createChildMock(): ChildMock {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as ChildMock;
  child.pid = 4321;
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = vi.fn();
  return child;
}

let currentChild: ChildMock;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => currentChild),
  execSync: vi.fn(() => ''),
}));

function authHeaders(token = 'test-token'): HeadersInit {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

describe('/_kilo/doctor/run routes', () => {
  let app: Hono;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetAllMocks();
    _resetActiveRun();
    _resetStartQueue();
    currentChild = createChildMock();
    vi.mocked(spawn).mockImplementation(() => currentChild as unknown as ReturnType<typeof spawn>);
    app = new Hono();
    registerDoctorRoutes(app, 'test-token');
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ── Auth ────────────────────────────────────────────────────────────

  it('rejects requests without auth', async () => {
    const resp = await app.request('/_kilo/doctor/run', {
      method: 'POST',
      body: JSON.stringify({ fix: true }),
    });
    expect(resp.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const resp = await app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders('wrong-token'),
      body: JSON.stringify({ fix: true }),
    });
    expect(resp.status).toBe(401);
  });

  // ── Spawn args ──────────────────────────────────────────────────────

  it('spawns openclaw with --fix when fix=true', async () => {
    const promise = app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: true }),
    });

    // Wait a tick for the spawn to happen, then emit close(0).
    await new Promise(r => setImmediate(r));
    currentChild.stdout.emit('data', Buffer.from('doctor output line\n'));
    currentChild.emit('close', 0, null);

    const resp = await promise;
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.status).toBe('completed');
    expect(body.exitCode).toBe(0);
    expect(body.fix).toBe(true);
    expect(body.output).toContain('doctor output line');
    expect(body.timedOut).toBe(false);

    const spawnMock = vi.mocked(spawn);
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0][0]).toBe('openclaw');
    expect(spawnMock.mock.calls[0][1]).toEqual(['doctor', '--fix', '--non-interactive']);
    expect(spawnMock.mock.calls[0][2]).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
  });

  it('spawns openclaw without --fix when fix=false', async () => {
    const promise = app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: false }),
    });

    await new Promise(r => setImmediate(r));
    currentChild.emit('close', 0, null);

    const resp = await promise;
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.fix).toBe(false);

    const spawnMock = vi.mocked(spawn);
    expect(spawnMock.mock.calls[0][1]).toEqual(['doctor', '--non-interactive']);
  });

  it('defaults fix to true when body is empty or missing', async () => {
    const promise = app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders(),
    });

    await new Promise(r => setImmediate(r));
    currentChild.emit('close', 0, null);

    const resp = await promise;
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.fix).toBe(true);

    const spawnMock = vi.mocked(spawn);
    expect(spawnMock.mock.calls[0][1]).toEqual(['doctor', '--fix', '--non-interactive']);
  });

  // ── Exit codes ──────────────────────────────────────────────────────

  it('reports status=failed on non-zero exit', async () => {
    const promise = app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: true }),
    });

    await new Promise(r => setImmediate(r));
    currentChild.stderr.emit('data', Buffer.from('something broke\n'));
    currentChild.emit('close', 7, null);

    const resp = await promise;
    const body = (await resp.json()) as Record<string, unknown>;
    expect(resp.status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.status).toBe('failed');
    expect(body.exitCode).toBe(7);
    expect(body.output).toContain('something broke');
  });

  it('merges stdout and stderr into a single output buffer', async () => {
    const promise = app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: false }),
    });

    await new Promise(r => setImmediate(r));
    currentChild.stdout.emit('data', Buffer.from('OUT1\n'));
    currentChild.stderr.emit('data', Buffer.from('ERR1\n'));
    currentChild.stdout.emit('data', Buffer.from('OUT2\n'));
    currentChild.emit('close', 0, null);

    const resp = await promise;
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.output).toContain('OUT1');
    expect(body.output).toContain('ERR1');
    expect(body.output).toContain('OUT2');
  });

  // ── Concurrency ─────────────────────────────────────────────────────

  it('rejects concurrent runs with 409', async () => {
    const first = app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: true }),
    });

    await new Promise(r => setImmediate(r));

    const second = await app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: true }),
    });

    expect(second.status).toBe(409);
    const body = (await second.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      code: 'openclaw_doctor_already_active',
      error: expect.stringContaining('already in progress'),
    });

    // Finish the first so no hanging promises.
    currentChild.emit('close', 0, null);
    await first;
  });

  it('accepts a new run after the previous one completes', async () => {
    const first = app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: true }),
    });
    await new Promise(r => setImmediate(r));
    currentChild.emit('close', 0, null);
    const firstResp = await first;
    expect(firstResp.status).toBe(200);

    currentChild = createChildMock();
    const second = app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: false }),
    });
    await new Promise(r => setImmediate(r));
    currentChild.emit('close', 0, null);
    const secondResp = await second;
    expect(secondResp.status).toBe(200);
  });

  // ── Buffer cap ──────────────────────────────────────────────────────

  it('front-truncates output when it exceeds the cap', async () => {
    const promise = app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: false }),
    });
    await new Promise(r => setImmediate(r));

    // Push ~1.2MB of output.
    const big = 'X'.repeat(600_000);
    currentChild.stdout.emit('data', Buffer.from(big));
    currentChild.stdout.emit('data', Buffer.from(big));
    currentChild.stdout.emit('data', Buffer.from('TAIL_MARKER'));
    currentChild.emit('close', 0, null);

    const resp = await promise;
    const body = (await resp.json()) as { output: string };
    expect(body.output.length).toBeLessThanOrEqual(1_048_576 + 128); // +truncation marker
    expect(body.output).toContain('[output truncated]');
    expect(body.output.endsWith('TAIL_MARKER')).toBe(true);
  });

  // ── Timeout ─────────────────────────────────────────────────────────

  it('kills the child and returns timed_out after the hard timeout', async () => {
    vi.useFakeTimers();
    try {
      const promise = app.request('/_kilo/doctor/run', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ fix: true }),
      });
      await Promise.resolve();
      await Promise.resolve();

      // Advance past the 120s cap.
      await vi.advanceTimersByTimeAsync(120_000);

      const resp = await promise;
      const body = (await resp.json()) as Record<string, unknown>;
      expect(resp.status).toBe(200);
      expect(body.status).toBe('timed_out');
      expect(body.timedOut).toBe(true);
      expect(body.ok).toBe(false);
      expect(body.output).toContain('timed out');
      expect(currentChild.kill).toHaveBeenCalledWith('SIGTERM');

      // Advance past the SIGKILL grace window.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(currentChild.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Process-level errors ────────────────────────────────────────────

  it('reports status=failed when spawn emits error', async () => {
    const promise = app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: false }),
    });
    await new Promise(r => setImmediate(r));

    currentChild.emit('error', new Error('ENOENT: openclaw not found'));

    const resp = await promise;
    const body = (await resp.json()) as Record<string, unknown>;
    expect(resp.status).toBe(200);
    expect(body.status).toBe('failed');
    expect(body.exitCode).toBeNull();
    expect(body.output).toContain('ENOENT');
  });

  it('does not leave activeRun in running state after completion', async () => {
    const promise = app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: true }),
    });
    await new Promise(r => setImmediate(r));
    currentChild.emit('close', 0, null);
    await promise;

    const run = _getActiveRun();
    expect(run?.status).toBe('completed');
  });

  // ── Client-disconnect abort ─────────────────────────────────────────

  it('kills the child and returns status=cancelled when the client aborts mid-run', async () => {
    const controller = new AbortController();
    const promise = app.request('/_kilo/doctor/run', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: true }),
      signal: controller.signal,
    });

    // Let the spawn + route handler register the abort listener, then abort
    // before the child emits close.
    await new Promise(r => setImmediate(r));
    controller.abort();

    const resp = await promise;
    const body = (await resp.json()) as Record<string, unknown>;
    expect(resp.status).toBe(200);
    expect(body.status).toBe('cancelled');
    expect(body.ok).toBe(false);
    expect(body.output).toContain('cancelled by client disconnect');
    expect(currentChild.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

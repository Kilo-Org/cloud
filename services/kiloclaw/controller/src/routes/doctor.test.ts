import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  registerDoctorRoutes,
  _getActiveRun,
  _resetActiveRun,
  _resetStartQueue,
  _setDoctorRunDirForTest,
} from './doctor';

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

async function jsonBody(resp: Response): Promise<Record<string, unknown>> {
  return resp.json();
}

describe('/_kilo/doctor routes', () => {
  let app: Hono;
  const originalEnv = { ...process.env };
  let tempRoot: string;
  let metadataPath: string;
  let logPath: string;

  beforeEach(() => {
    vi.resetAllMocks();
    _resetActiveRun();
    _resetStartQueue();
    currentChild = createChildMock();
    vi.mocked(spawn).mockImplementation(() => currentChild as unknown as ReturnType<typeof spawn>);
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'));
    _setDoctorRunDirForTest(tempRoot);
    metadataPath = path.join(tempRoot, 'current.json');
    logPath = path.join(tempRoot, 'current.log');

    app = new Hono();
    registerDoctorRoutes(app, 'test-token');
  });

  afterEach(() => {
    _resetActiveRun();
    process.env = { ...originalEnv };
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('rejects requests without auth', async () => {
    const resp = await app.request('/_kilo/doctor/status');
    expect(resp.status).toBe(401);
  });

  it('rejects requests with wrong token', async () => {
    const resp = await app.request('/_kilo/doctor/status', { headers: authHeaders('wrong-token') });
    expect(resp.status).toBe(401);
  });

  it('returns hasRun=false before a run starts', async () => {
    const resp = await app.request('/_kilo/doctor/status', { headers: authHeaders() });
    expect(resp.status).toBe(200);
    expect(await jsonBody(resp)).toMatchObject({ hasRun: false, status: null, output: null });
  });

  it('starts openclaw doctor with --fix by default and returns immediately', async () => {
    const resp = await app.request('/_kilo/doctor/start', {
      method: 'POST',
      headers: authHeaders(),
    });

    expect(resp.status).toBe(200);
    const body = await jsonBody(resp);
    expect(body.ok).toBe(true);
    expect(typeof body.runId).toBe('string');
    expect(typeof body.startedAt).toBe('string');

    expect(_getActiveRun()).not.toBeNull();
    expect(spawn).toHaveBeenCalledOnce();
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe('openclaw');
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(['doctor', '--fix', '--non-interactive']);
    expect(vi.mocked(spawn).mock.calls[0][2]).toMatchObject({
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    expect(fs.existsSync(metadataPath)).toBe(true);
    expect(fs.existsSync(logPath)).toBe(true);
  });

  it('rejects malformed JSON instead of defaulting to --fix', async () => {
    const resp = await app.request('/_kilo/doctor/start', {
      method: 'POST',
      headers: authHeaders(),
      body: '{not-json',
    });

    expect(resp.status).toBe(400);
    expect(await jsonBody(resp)).toMatchObject({ error: 'Invalid JSON body' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('starts openclaw doctor without --fix when fix=false', async () => {
    const resp = await app.request('/_kilo/doctor/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: false }),
    });

    expect(resp.status).toBe(200);
    expect(vi.mocked(spawn).mock.calls[0][1]).toEqual(['doctor', '--non-interactive']);

    const status = await app.request('/_kilo/doctor/status', { headers: authHeaders() });
    expect(await jsonBody(status)).toMatchObject({ hasRun: true, status: 'running', fix: false });
  });

  it('rejects concurrent starts with 409', async () => {
    await app.request('/_kilo/doctor/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: true }),
    });

    const second = await app.request('/_kilo/doctor/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: true }),
    });

    expect(second.status).toBe(409);
    expect(await jsonBody(second)).toMatchObject({
      code: 'openclaw_doctor_already_active',
      error: expect.stringContaining('already in progress'),
    });
  });

  it('status returns running output while active and final output after close', async () => {
    await app.request('/_kilo/doctor/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: true }),
    });

    currentChild.stdout.emit('data', Buffer.from('doctor output\n'));
    currentChild.stderr.emit('data', Buffer.from('doctor warning\n'));

    const running = await app.request('/_kilo/doctor/status', { headers: authHeaders() });
    expect(await jsonBody(running)).toMatchObject({
      hasRun: true,
      status: 'running',
      output: expect.stringContaining('doctor output'),
      exitCode: null,
    });

    currentChild.emit('close', 0, null);

    const completed = await app.request('/_kilo/doctor/status', { headers: authHeaders() });
    expect(await jsonBody(completed)).toMatchObject({
      hasRun: true,
      status: 'completed',
      output: expect.stringContaining('doctor warning'),
      exitCode: 0,
      timedOut: false,
    });
    expect(_getActiveRun()).toBeNull();
  });

  it('reports failed on non-zero exit', async () => {
    await app.request('/_kilo/doctor/start', { method: 'POST', headers: authHeaders() });
    currentChild.stderr.emit('data', Buffer.from('something broke\n'));
    currentChild.emit('close', 7, null);

    const resp = await app.request('/_kilo/doctor/status', { headers: authHeaders() });
    expect(await jsonBody(resp)).toMatchObject({
      status: 'failed',
      exitCode: 7,
      output: expect.stringContaining('something broke'),
    });
  });

  it('cancels an active run explicitly', async () => {
    await app.request('/_kilo/doctor/start', { method: 'POST', headers: authHeaders() });

    const resp = await app.request('/_kilo/doctor/cancel', {
      method: 'POST',
      headers: authHeaders(),
    });

    expect(resp.status).toBe(200);
    expect(await jsonBody(resp)).toMatchObject({ ok: true });
    expect(currentChild.kill).toHaveBeenCalledWith('SIGTERM');

    const status = await app.request('/_kilo/doctor/status', { headers: authHeaders() });
    expect(await jsonBody(status)).toMatchObject({
      status: 'cancelled',
      output: expect.stringContaining('cancelled by operator'),
    });
    expect(_getActiveRun()).not.toBeNull();
    const retry = await app.request('/_kilo/doctor/start', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(retry.status).toBe(409);

    currentChild.emit('close', null, 'SIGTERM');
    expect(_getActiveRun()).toBeNull();
  });

  it('returns 409 when cancelling without an active run', async () => {
    const resp = await app.request('/_kilo/doctor/cancel', {
      method: 'POST',
      headers: authHeaders(),
    });
    expect(resp.status).toBe(409);
    expect(await jsonBody(resp)).toMatchObject({
      code: 'openclaw_doctor_no_active_run',
      error: 'No active doctor run to cancel',
    });
  });

  it('times out the child and records timed_out status', async () => {
    vi.useFakeTimers();
    try {
      await app.request('/_kilo/doctor/start', { method: 'POST', headers: authHeaders() });
      await vi.advanceTimersByTimeAsync(120_000);

      expect(currentChild.kill).toHaveBeenCalledWith('SIGTERM');
      const status = await app.request('/_kilo/doctor/status', { headers: authHeaders() });
      expect(await jsonBody(status)).toMatchObject({
        status: 'timed_out',
        timedOut: true,
        output: expect.stringContaining('timed out'),
      });
      expect(_getActiveRun()).not.toBeNull();

      const retry = await app.request('/_kilo/doctor/start', {
        method: 'POST',
        headers: authHeaders(),
      });
      expect(retry.status).toBe(409);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(currentChild.kill).toHaveBeenCalledWith('SIGKILL');

      currentChild.emit('close', null, 'SIGKILL');
      expect(_getActiveRun()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('front-truncates output when it exceeds the cap', async () => {
    await app.request('/_kilo/doctor/start', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ fix: false }),
    });

    const big = 'X'.repeat(600_000);
    currentChild.stdout.emit('data', Buffer.from(big));
    currentChild.stdout.emit('data', Buffer.from(big));
    currentChild.stdout.emit('data', Buffer.from('TAIL_MARKER'));

    const resp = await app.request('/_kilo/doctor/status', { headers: authHeaders() });
    const body = await jsonBody(resp);
    expect(String(body.output).length).toBeLessThanOrEqual(1_048_576 + 128);
    expect(body.output).toContain('[output truncated]');
    expect(String(body.output).endsWith('TAIL_MARKER')).toBe(true);
    expect(body.outputTruncated).toBe(true);
  });

  it('marks stale running metadata as failed when no active process exists', async () => {
    const startedAt = new Date().toISOString();
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.writeFileSync(
      metadataPath,
      JSON.stringify({
        hasRun: true,
        runId: 'stale-run',
        status: 'running',
        fix: true,
        exitCode: null,
        startedAt,
        completedAt: null,
        timedOut: false,
        outputBytes: 0,
        outputTruncated: false,
      })
    );
    fs.writeFileSync(logPath, 'partial output\n');

    const resp = await app.request('/_kilo/doctor/status', { headers: authHeaders() });
    expect(await jsonBody(resp)).toMatchObject({
      hasRun: true,
      runId: 'stale-run',
      status: 'failed',
      output: expect.stringContaining('interrupted by controller restart'),
    });
  });
});

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSupervisor } from './supervisor';

class FakeChildProcess extends EventEmitter {
  pid: number;
  stdout: null;
  stderr: null;
  kill = vi.fn((_signal: NodeJS.Signals | 'SIGKILL') => true);

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdout = null;
    this.stderr = null;
  }
}

function createSpawnHarness() {
  const children: FakeChildProcess[] = [];
  let pid = 1000;
  const spawnImpl = vi.fn(() => {
    const child = new FakeChildProcess(pid++);
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child as never;
  });
  return { spawnImpl, children };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-02-21T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createSupervisor', () => {
  it('escalates backoff on repeated crashes and caps at max', async () => {
    const { spawnImpl, children } = createSpawnHarness();
    const supervisor = createSupervisor({
      args: ['gateway', '--port', '3001'],
      spawnImpl: spawnImpl as never,
      backoffInitialMs: 1_000,
      backoffMaxMs: 4_000,
      backoffMultiplier: 2,
      healthyThresholdMs: 30_000,
    });

    await supervisor.start();
    await flushMicrotasks();

    children[0].emit('exit', 1, null);
    vi.advanceTimersByTime(1_000);
    await flushMicrotasks();

    children[1].emit('exit', 1, null);
    vi.advanceTimersByTime(2_000);
    await flushMicrotasks();

    children[2].emit('exit', 1, null);
    vi.advanceTimersByTime(4_000);
    await flushMicrotasks();

    children[3].emit('exit', 1, null);
    vi.advanceTimersByTime(4_000);
    await flushMicrotasks();

    expect(spawnImpl).toHaveBeenCalledTimes(5);
    expect(supervisor.getStats().restarts).toBe(4);
  });

  it('resets backoff after a healthy run', async () => {
    const { spawnImpl, children } = createSpawnHarness();
    const supervisor = createSupervisor({
      args: ['gateway', '--port', '3001'],
      spawnImpl: spawnImpl as never,
      backoffInitialMs: 1_000,
      backoffMaxMs: 8_000,
      backoffMultiplier: 2,
      healthyThresholdMs: 10_000,
    });

    await supervisor.start();
    await flushMicrotasks();

    children[0].emit('exit', 1, null);
    vi.advanceTimersByTime(1_000);
    await flushMicrotasks();

    children[1].emit('exit', 1, null);
    vi.advanceTimersByTime(2_000);
    await flushMicrotasks();

    vi.advanceTimersByTime(10_001);
    children[2].emit('exit', 1, null);

    vi.advanceTimersByTime(999);
    expect(spawnImpl).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(spawnImpl).toHaveBeenCalledTimes(4);
  });

  it('cancels pending restart when stopped during crash loop', async () => {
    const { spawnImpl, children } = createSpawnHarness();
    const supervisor = createSupervisor({
      args: ['gateway', '--port', '3001'],
      spawnImpl: spawnImpl as never,
      backoffInitialMs: 1_000,
      backoffMaxMs: 4_000,
      backoffMultiplier: 2,
    });

    await supervisor.start();
    await flushMicrotasks();
    children[0].emit('exit', 1, null);

    await supervisor.stop();
    expect(supervisor.getState()).toBe('stopped');

    vi.advanceTimersByTime(10_000);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('stops a running child with SIGTERM and transitions to stopped', async () => {
    const { spawnImpl, children } = createSpawnHarness();
    const supervisor = createSupervisor({
      args: ['gateway', '--port', '3001'],
      spawnImpl: spawnImpl as never,
    });

    await supervisor.start();
    await flushMicrotasks();
    const stopPromise = supervisor.stop();
    await flushMicrotasks();

    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    children[0].emit('exit', 0, 'SIGTERM');
    await stopPromise;

    expect(supervisor.getState()).toBe('stopped');
  });

  it('restarts by stopping then starting a new child', async () => {
    const { spawnImpl, children } = createSpawnHarness();
    const supervisor = createSupervisor({
      args: ['gateway', '--port', '3001'],
      spawnImpl: spawnImpl as never,
    });

    await supervisor.start();
    await flushMicrotasks();

    const restartPromise = supervisor.restart();
    await flushMicrotasks();
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    children[0].emit('exit', 0, 'SIGTERM');
    await restartPromise;
    await flushMicrotasks();

    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(supervisor.getState()).toBe('running');
  });

  it('treats start as idempotent when already running', async () => {
    const { spawnImpl } = createSpawnHarness();
    const supervisor = createSupervisor({
      args: ['gateway', '--port', '3001'],
      spawnImpl: spawnImpl as never,
    });

    const first = await supervisor.start();
    await flushMicrotasks();
    const second = await supervisor.start();

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
  });

  it('respawns immediately without backoff or crash counter on clean exit (code 0)', async () => {
    const { spawnImpl, children } = createSpawnHarness();
    const supervisor = createSupervisor({
      args: ['gateway', '--port', '3001'],
      spawnImpl: spawnImpl as never,
      backoffInitialMs: 5_000,
      backoffMaxMs: 60_000,
      backoffMultiplier: 2,
    });

    await supervisor.start();
    await flushMicrotasks();

    // Gateway exits cleanly (e.g., SIGUSR1 supervised restart after update.run)
    children[0].emit('exit', 0, null);
    await flushMicrotasks();

    // Should respawn immediately — no backoff delay needed
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(supervisor.getStats().restarts).toBe(1);
    expect(supervisor.getState()).toBe('running');

    // A subsequent crash should still use initial backoff (not escalated)
    children[1].emit('exit', 1, null);
    expect(supervisor.getStats().restarts).toBe(2);
    vi.advanceTimersByTime(4_999);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(spawnImpl).toHaveBeenCalledTimes(3);
  });

  it('treats signal-killed exit (code 0 + signal) as a crash', async () => {
    const { spawnImpl, children } = createSpawnHarness();
    const supervisor = createSupervisor({
      args: ['gateway', '--port', '3001'],
      spawnImpl: spawnImpl as never,
      backoffInitialMs: 1_000,
    });

    await supervisor.start();
    await flushMicrotasks();

    // Killed by signal — not a clean exit even though code may be 0
    children[0].emit('exit', 0, 'SIGKILL');
    expect(supervisor.getStats().restarts).toBe(1);
    expect(supervisor.getState()).toBe('crashed');
  });

  it('signal() sends signal to running child and returns true', async () => {
    const { spawnImpl, children } = createSpawnHarness();
    const supervisor = createSupervisor({
      args: ['gateway', '--port', '3001'],
      spawnImpl: spawnImpl as never,
    });

    // No child yet — signal returns false
    expect(supervisor.signal('SIGUSR1')).toBe(false);

    await supervisor.start();
    await flushMicrotasks();

    // Child running — signal returns true and forwards to child
    expect(supervisor.signal('SIGUSR1')).toBe(true);
    expect(children[0].kill).toHaveBeenCalledWith('SIGUSR1');
  });

  it('forwards SIGTERM on shutdown and suppresses restarts', async () => {
    const { spawnImpl, children } = createSpawnHarness();
    const supervisor = createSupervisor({
      args: ['gateway', '--port', '3001'],
      spawnImpl: spawnImpl as never,
    });

    await supervisor.start();
    await flushMicrotasks();

    const shutdownPromise = supervisor.shutdown('SIGTERM');
    await flushMicrotasks();
    expect(children[0].kill).toHaveBeenCalledWith('SIGTERM');
    children[0].emit('exit', 0, 'SIGTERM');
    await shutdownPromise;

    vi.advanceTimersByTime(60_000);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(supervisor.getState()).toBe('shutting_down');
  });
});

class FakeChildProcessWithStdout extends EventEmitter {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  kill = vi.fn((_signal: NodeJS.Signals | 'SIGKILL') => true);

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }
}

function createSpawnHarnessWithStdout() {
  const children: FakeChildProcessWithStdout[] = [];
  let pid = 2000;
  const spawnImpl = vi.fn(() => {
    const child = new FakeChildProcessWithStdout(pid++);
    children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child as never;
  });
  return { spawnImpl, children };
}

describe('onStdoutLine callback', () => {
  it('delivers complete lines to the callback', async () => {
    const { spawnImpl, children } = createSpawnHarnessWithStdout();
    const lines: string[] = [];
    const supervisor = createSupervisor({
      args: ['--port', '3001'],
      spawnImpl: spawnImpl as never,
      onStdoutLine: line => lines.push(line),
    });

    await supervisor.start();
    await flushMicrotasks();

    children[0].stdout.push('hello world\n');
    expect(lines).toEqual(['hello world']);
  });

  it('buffers partial lines until newline', async () => {
    const { spawnImpl, children } = createSpawnHarnessWithStdout();
    const lines: string[] = [];
    const supervisor = createSupervisor({
      args: ['--port', '3001'],
      spawnImpl: spawnImpl as never,
      onStdoutLine: line => lines.push(line),
    });

    await supervisor.start();
    await flushMicrotasks();

    children[0].stdout.push('partial');
    expect(lines).toEqual([]);

    children[0].stdout.push(' line\n');
    expect(lines).toEqual(['partial line']);
  });

  it('handles multiple lines in one chunk', async () => {
    const { spawnImpl, children } = createSpawnHarnessWithStdout();
    const lines: string[] = [];
    const supervisor = createSupervisor({
      args: ['--port', '3001'],
      spawnImpl: spawnImpl as never,
      onStdoutLine: line => lines.push(line),
    });

    await supervisor.start();
    await flushMicrotasks();

    children[0].stdout.push('line1\nline2\nline3\n');
    expect(lines).toEqual(['line1', 'line2', 'line3']);
  });

  it('resets line buffer when child exits', async () => {
    const { spawnImpl, children } = createSpawnHarnessWithStdout();
    const lines: string[] = [];
    const supervisor = createSupervisor({
      args: ['--port', '3001'],
      spawnImpl: spawnImpl as never,
      onStdoutLine: line => lines.push(line),
    });

    await supervisor.start();
    await flushMicrotasks();

    children[0].stdout.push('partial data without newline');
    children[0].emit('exit', 1, null);

    // Partial data should be discarded, not delivered
    expect(lines).toEqual([]);
  });

  it('still pipes stdout to process.stdout when callback is set', async () => {
    const { spawnImpl, children } = createSpawnHarnessWithStdout();
    const pipeSpy = vi.spyOn(
      children.length === 0 ? PassThrough.prototype : PassThrough.prototype,
      'pipe'
    );
    const supervisor = createSupervisor({
      args: ['--port', '3001'],
      spawnImpl: spawnImpl as never,
      onStdoutLine: () => {},
    });

    await supervisor.start();
    await flushMicrotasks();

    expect(children[0].stdout.pipe).toBeDefined();
    // Verify pipe was called (stdout is piped to process.stdout)
    expect(pipeSpy).toHaveBeenCalled();
    pipeSpy.mockRestore();
  });

  it('continues delivering lines after onStdoutLine callback throws', async () => {
    const { spawnImpl, children } = createSpawnHarnessWithStdout();
    const lines: string[] = [];
    let callCount = 0;
    const supervisor = createSupervisor({
      args: ['--port', '3001'],
      spawnImpl: spawnImpl as never,
      onStdoutLine: line => {
        callCount++;
        if (callCount === 2) {
          throw new Error('callback boom');
        }
        lines.push(line);
      },
    });

    await supervisor.start();
    await flushMicrotasks();

    // Push three lines — the second will throw
    children[0].stdout.push('line1\nline2\nline3\n');

    // line1 delivered, line2 threw, line3 still delivered
    expect(lines).toEqual(['line1', 'line3']);
    expect(supervisor.getState()).toBe('running');
  });

  it('works without onStdoutLine callback (backward compat)', async () => {
    const { spawnImpl, children } = createSpawnHarnessWithStdout();
    const supervisor = createSupervisor({
      args: ['--port', '3001'],
      spawnImpl: spawnImpl as never,
    });

    await supervisor.start();
    await flushMicrotasks();

    // Should not crash when pushing data without a callback
    children[0].stdout.push('some output\n');
    expect(supervisor.getState()).toBe('running');
  });
});

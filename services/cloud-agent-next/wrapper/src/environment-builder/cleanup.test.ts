import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createOwnedProcessScope } from '../control/owned-processes';
import { stopOwnedProcesses } from './cleanup';

function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2).trim()[0];
    return state !== 'Z' && state !== 'X' && state !== 'x';
  } catch {
    return false;
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 40 && processAlive(pid); attempt += 1) {
    await Bun.sleep(50);
  }
  expect(processAlive(pid)).toBe(false);
}

function daemonScript(): string {
  return [
    'const {spawn}=require("node:child_process");',
    'const c=spawn("sleep",["60"],{detached:true,stdio:"ignore"});',
    'console.log(c.pid);',
    'c.unref();',
  ].join(' ');
}

async function spawnDaemon(scope: ReturnType<typeof createOwnedProcessScope>): Promise<number> {
  const child = scope.spawn('node', ['-e', daemonScript()], {});
  const pid = await new Promise<number>(resolve => {
    child.stdout.once('data', chunk => resolve(Number(String(chunk).trim())));
  });
  await new Promise<void>(resolve => child.once('close', () => resolve()));
  return pid;
}

describe('stopOwnedProcesses', () => {
  it('stops and disposes an owned process scope', async () => {
    const scope = {
      stopSpawned: vi.fn(async () => true),
      dispose: vi.fn(),
      releaseAbandoned: vi.fn(),
    };
    await stopOwnedProcesses(scope, 123);
    expect(scope.stopSpawned).toHaveBeenCalledWith(123);
    expect(scope.dispose).toHaveBeenCalledOnce();
    expect(scope.releaseAbandoned).not.toHaveBeenCalled();
  });

  it('fails the capture when setup processes cannot be stopped', async () => {
    const scope = {
      stopSpawned: vi.fn(async () => false),
      dispose: vi.fn(),
      releaseAbandoned: vi.fn(),
    };
    let failure: unknown;
    try {
      await stopOwnedProcesses(scope, 123);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('Setup processes could not be stopped');
    expect(scope.dispose).not.toHaveBeenCalled();
    expect(scope.releaseAbandoned).toHaveBeenCalledOnce();
  });

  it('kills a detached setup process group without cgroup delegation', async () => {
    const scope = createOwnedProcessScope();
    expect(await scope.captureSpawnBaseline()).toBe(true);
    const child = scope.spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], {});
    const grandchild = await new Promise<number>(resolve => {
      child.stdout.once('data', chunk => resolve(Number(String(chunk).trim())));
    });

    await stopOwnedProcesses(scope, Date.now() + 5_000);

    await expectProcessGone(grandchild);
  });

  it('kills a setup descendant that daemonizes into a new group after its parent exits', async () => {
    const scope = createOwnedProcessScope();
    expect(await scope.captureSpawnBaseline()).toBe(true);
    const daemon = await spawnDaemon(scope);

    await stopOwnedProcesses(scope, Date.now() + 5_000);

    await expectProcessGone(daemon);
  });

  it('preserves unrelated processes captured in the baseline while stopping setup descendants', async () => {
    const unrelated = Bun.spawn(['sleep', '60'], { stdio: ['ignore', 'ignore', 'ignore'] });
    try {
      const scope = createOwnedProcessScope();
      expect(await scope.captureSpawnBaseline()).toBe(true);
      const daemon = await spawnDaemon(scope);

      await stopOwnedProcesses(scope, Date.now() + 5_000);

      expect(processAlive(unrelated.pid)).toBe(true);
      await expectProcessGone(daemon);
    } finally {
      unrelated.kill('SIGKILL');
      await unrelated.exited;
    }
  });

  it('refuses to stop without an explicit pre-spawn baseline', async () => {
    const scope = createOwnedProcessScope();
    const child = scope.spawn('sleep', ['60'], {});
    try {
      expect(await scope.stopSpawned(Date.now() + 2_000)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });
});

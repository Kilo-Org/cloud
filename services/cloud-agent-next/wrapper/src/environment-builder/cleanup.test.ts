import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { createOwnedProcessScope } from '../control/owned-processes';
import { stopOwnedProcesses } from './cleanup';

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
    const child = scope.spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], {});
    const grandchild = await new Promise<number>(resolve => {
      child.stdout.once('data', chunk => resolve(Number(String(chunk).trim())));
    });

    await stopOwnedProcesses(scope, Date.now() + 5_000);

    for (let attempt = 0; attempt < 40 && existsSync(`/proc/${grandchild}`); attempt += 1) {
      await Bun.sleep(50);
    }
    expect(existsSync(`/proc/${grandchild}`)).toBe(false);
  });
});

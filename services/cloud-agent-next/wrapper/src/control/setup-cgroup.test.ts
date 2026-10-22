import { afterEach, describe, expect, it } from 'bun:test';
import {
  closeSync,
  constants,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { runProcess, type ProcessSpawn } from '../utils.js';
import { applySetupLimits, createSetupSpawn, spawnInCgroup } from './setup-cgroup.js';

const directories: string[] = [];
const descriptors: number[] = [];

afterEach(() => {
  for (const descriptor of descriptors.splice(0)) closeSync(descriptor);
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fakeLeaf(flags = constants.O_WRONLY) {
  const directory = mkdtempSync(path.join(tmpdir(), 'setup-cgroup-'));
  directories.push(directory);
  const procsPath = path.join(directory, 'cgroup.procs');
  writeFileSync(procsPath, '');
  const procs = openSync(procsPath, flags);
  descriptors.push(procs);
  const spawnSetup: ProcessSpawn = (command, args, options) =>
    spawnInCgroup({ procs, procsPath }, command, args, options);
  return { directory, procsPath, spawnSetup };
}

function runSetup(script: string, spawnSetup: ProcessSpawn, args: string[] = []) {
  return runProcess('sh', ['-c', script, 'sh', ...args], {
    spawn: spawnSetup,
    hardTimeoutMs: 10_000,
  });
}

describe('spawnInCgroup', () => {
  it('moves the setup command into the leaf before it runs', async () => {
    const { procsPath, spawnSetup } = fakeLeaf();

    const result = await runSetup('echo "$$"; cat "$1"', spawnSetup, [procsPath]);

    const [pid, placed] = result.stdout.trim().split('\n');
    expect(result.exitCode).toBe(0);
    expect(placed).toBe(pid);
  });

  it('keeps stdin closed so a reading command does not wait', async () => {
    const { spawnSetup } = fakeLeaf();

    const result = await runSetup('read line; echo "status=$?"', spawnSetup);

    expect(result.stdout.trim()).toBe('status=1');
    expect(result.terminationReason).toBeUndefined();
  });

  it('runs the command once, unmanaged, when placement fails', async () => {
    const { directory, spawnSetup } = fakeLeaf(constants.O_RDONLY);
    const marker = path.join(directory, 'ran');

    const result = await runSetup('echo ran >> "$1"; echo done', spawnSetup, [marker]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('done');
    expect(readFileSync(marker, 'utf8')).toBe('ran\n');
  });

  it('leaves descriptors it does not own open once the child is collected', async () => {
    const { procsPath, spawnSetup } = fakeLeaf();
    await runSetup('echo ok', spawnSetup);

    const sentinels = Array.from({ length: 8 }, () => openSync(procsPath, constants.O_RDONLY));
    descriptors.push(...sentinels);
    // Bun closes a collected subprocess's pipes on a later event-loop turn.
    for (let round = 0; round < 5; round++) {
      Bun.gc(true);
      await setImmediate();
    }

    const closed = sentinels.filter(descriptor => {
      try {
        fstatSync(descriptor);
        return false;
      } catch {
        return true;
      }
    });
    expect(closed).toEqual([]);
  });
});

describe('createSetupSpawn', () => {
  it('runs setup unmanaged without a workload placement', async () => {
    const result = await runSetup('echo ok', createSetupSpawn({ enabled: false }));

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('ok');
  });
});

describe('applySetupLimits', () => {
  it('kills only the largest setup process on OOM and disables swap', () => {
    const { directory } = fakeLeaf();

    applySetupLimits(directory);

    expect(readFileSync(path.join(directory, 'memory.oom.group'), 'utf8')).toBe('0');
    expect(readFileSync(path.join(directory, 'memory.swap.max'), 'utf8')).toBe('0');
  });
});

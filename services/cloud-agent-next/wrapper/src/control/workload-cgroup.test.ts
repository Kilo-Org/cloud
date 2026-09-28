import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import * as fs from 'node:fs';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  controlDiagnosticRecordSchema,
  createControlDiagnosticRecord,
} from '../../../src/shared/control-diagnostics.js';
import { createOwnedProcessScope } from './owned-processes.js';
import {
  admitControlWorkload,
  applyManagedWorkloadLimits,
  classifyWorkloadMembers,
  closeControlWorkload,
  createWorkloadReporter,
  computeWorkloadBudget,
  initializeControlWorkload,
  parsePressureTotal,
  type ControlWorkload,
  type WorkloadPlacement,
  type WorkloadProcessEntry,
} from './workload-cgroup.js';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const RESERVE_BYTES = 2048 * MIB;

const roots: string[] = [];
const placements: ControlWorkload[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workload-cgroup-'));
  roots.push(root);
  return root;
}

function writeControl(directory: string, name: string, value: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, name), value);
}

function selfCgroupFile(root: string, membership: string): string {
  const file = path.join(root, 'self-cgroup');
  writeFileSync(file, `0::${membership}\n`);
  return file;
}

function runInitialize(input: {
  root: string;
  membership: string;
  env: Record<string, string | undefined>;
  procRoot?: string;
  platform?: NodeJS.Platform;
}): ControlWorkload {
  const workload = initializeControlWorkload({
    env: input.env,
    cgroupRoot: input.root,
    selfCgroupFile: selfCgroupFile(input.root, input.membership),
    procRoot: input.procRoot ?? path.join(input.root, 'proc'),
    isCgroupMount: () => true,
    handlePath: (_descriptor, directory) => directory,
    platform: input.platform ?? 'linux',
  });
  placements.push(workload);
  return workload;
}

function procWithMemTotal(root: string, memTotalKb: number): string {
  const procRoot = path.join(root, 'proc');
  mkdirSync(procRoot, { recursive: true });
  writeFileSync(path.join(procRoot, 'meminfo'), `MemTotal:\t${memTotalKb} kB\n`);
  return procRoot;
}

// Simulates the kernel no-internal-process rule: writing controllers to the mount root's
// subtree_control fails while the root is populated (or always, for the permanently unwritable
// case), and writing a pid to kilo-runtime's cgroup.procs moves that pid out of the root.
function runWithRootWriteSimulation(
  root: string,
  rejectSubtree: 'while-populated' | 'always',
  run: () => ControlWorkload
): { workload: ControlWorkload; subtreeAttempts: number } {
  const realWriteFileSync = fs.writeFileSync;
  const rootSubtree = path.join(root, 'cgroup.subtree_control');
  const rootProcs = path.join(root, 'cgroup.procs');
  const runtimeProcs = path.join(root, 'kilo-runtime', 'cgroup.procs');
  let subtreeAttempts = 0;
  const spy = spyOn(fs, 'writeFileSync').mockImplementation(((
    target: Parameters<typeof fs.writeFileSync>[0],
    data: Parameters<typeof fs.writeFileSync>[1],
    ...rest: unknown[]
  ): void => {
    if (typeof target === 'string' && target === rootSubtree) {
      subtreeAttempts += 1;
      const populated = existsSync(rootProcs) ? fs.readFileSync(rootProcs, 'utf8').trim() : '';
      if (rejectSubtree === 'always' || populated !== '') {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      }
    }
    if (typeof target === 'string' && target === runtimeProcs) {
      const moved = typeof data === 'string' ? data.trim() : '';
      const current = existsSync(runtimeProcs) ? fs.readFileSync(runtimeProcs, 'utf8') : '';
      const members = current
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '');
      if (!members.includes(moved)) members.push(moved);
      realWriteFileSync(runtimeProcs, `${members.join('\n')}\n`);
      const remaining = fs
        .readFileSync(rootProcs, 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line !== '' && line !== moved);
      realWriteFileSync(rootProcs, remaining.length > 0 ? `${remaining.join('\n')}\n` : '');
      return;
    }
    (realWriteFileSync as (t: unknown, d: unknown, ...r: unknown[]) => void)(target, data, ...rest);
  }) as typeof fs.writeFileSync);
  try {
    return { workload: run(), subtreeAttempts };
  } finally {
    spy.mockRestore();
  }
}

function selfCgroupDirectory(): string | undefined {
  if (process.platform !== 'linux') return undefined;
  let membership: string | undefined;
  try {
    membership = readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find(line => line.startsWith('0::'))
      ?.slice(3);
  } catch {
    return undefined;
  }
  if (!membership || !membership.startsWith('/')) return undefined;
  return path.join('/sys/fs/cgroup', membership);
}

// Creates a disposable cgroup hierarchy under the runner's own cgroup, verifies the controllers
// can be enabled and disabled, and returns the directory, or undefined when unavailable.
function tryCreateDisposableCgroup(): string | undefined {
  const parent = selfCgroupDirectory();
  if (parent === undefined) return undefined;
  const directory = path.join(parent, `kilo-workload-test-${randomUUID()}`);
  try {
    mkdirSync(directory);
  } catch {
    return undefined;
  }
  try {
    if (!existsSync(path.join(directory, 'cgroup.procs'))) throw new Error('no procs');
    writeFileSync(path.join(directory, 'cgroup.subtree_control'), '+memory +cpu');
    writeFileSync(path.join(directory, 'cgroup.subtree_control'), '-memory -cpu');
    return directory;
  } catch {
    try {
      rmdirSync(directory);
    } catch {
      // Best-effort cleanup of the disposable hierarchy.
    }
    return undefined;
  }
}

function probeDisposableCgroupSupport(): boolean {
  const directory = tryCreateDisposableCgroup();
  if (directory === undefined) return false;
  try {
    rmdirSync(directory);
  } catch {
    // Best-effort cleanup of the capability-probe hierarchy.
  }
  return true;
}

const canUseDisposableCgroup = probeDisposableCgroupSupport();

async function stopChild(child: ReturnType<typeof spawn> | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.kill('SIGKILL');
  } catch {
    return;
  }
  await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 2_000))]);
}

async function removeCgroupDirectory(directory: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      rmdirSync(directory);
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

function initialize(
  root: string,
  membership: string,
  env: Record<string, string | undefined> = {},
  procRoot?: string
): ControlWorkload {
  return runInitialize({
    root,
    membership,
    env: { CONTROL_WORKLOAD_CGROUP: '1', ...env },
    ...(procRoot === undefined ? {} : { procRoot }),
  });
}

function delegationTree(root: string): void {
  writeControl(path.join(root, 'a'), 'cgroup.subtree_control', 'memory cpu');
  writeControl(path.join(root, 'a'), 'memory.max', String(6 * GIB));
  mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
  writeControl(path.join(root, 'a', 'kilo-workloads'), 'cgroup.events', 'populated 0');
}

afterEach(() => {
  for (const workload of placements.splice(0)) closeControlWorkload(workload);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('workload budget', () => {
  it('reserves the fixed control budget for the 4, 6 and 12 GiB classes', () => {
    const cases: [number, number][] = [
      [4 * GIB, 2048 * MIB],
      [6 * GIB, 4096 * MIB],
      [12 * GIB, 10240 * MIB],
    ];
    for (const [limit, expected] of cases) {
      expect(computeWorkloadBudget({ limits: [limit], reserveBytes: RESERVE_BYTES })).toEqual({
        ok: true,
        containerLimitBytes: limit,
        aggregateMaxBytes: expected,
        source: 'cgroup',
      });
    }
  });

  it('reports no_finite_limit when no governing ancestor has a finite limit', () => {
    expect(
      computeWorkloadBudget({ limits: [undefined, undefined], reserveBytes: RESERVE_BYTES })
    ).toEqual({ ok: false, failure: 'no_finite_limit' });
    expect(computeWorkloadBudget({ limits: [], reserveBytes: RESERVE_BYTES })).toEqual({
      ok: false,
      failure: 'no_finite_limit',
    });
  });

  it('reports below_minimum when the aggregate would fall under 1 GiB', () => {
    expect(computeWorkloadBudget({ limits: [2560 * MIB], reserveBytes: RESERVE_BYTES })).toEqual({
      ok: false,
      failure: 'below_minimum',
    });
  });

  it('takes the tighter of the ancestor limit and the explicit limit', () => {
    expect(
      computeWorkloadBudget({
        limits: [8 * GIB],
        explicitLimitBytes: 4 * GIB,
        reserveBytes: RESERVE_BYTES,
      })
    ).toEqual({
      ok: true,
      containerLimitBytes: 4 * GIB,
      aggregateMaxBytes: 2048 * MIB,
      source: 'explicit',
    });
    expect(
      computeWorkloadBudget({
        limits: [4 * GIB],
        explicitLimitBytes: 8 * GIB,
        reserveBytes: RESERVE_BYTES,
      })
    ).toEqual({
      ok: true,
      containerLimitBytes: 4 * GIB,
      aggregateMaxBytes: 2048 * MIB,
      source: 'cgroup',
    });
  });

  it('prefers a finite cgroup limit over a larger meminfo total', () => {
    expect(
      computeWorkloadBudget({
        limits: [4 * GIB],
        memTotalBytes: 8 * GIB,
        reserveBytes: RESERVE_BYTES,
      })
    ).toEqual({
      ok: true,
      containerLimitBytes: 4 * GIB,
      aggregateMaxBytes: 2048 * MIB,
      source: 'cgroup',
    });
  });

  it('falls back to the meminfo total only when no cgroup or explicit limit is set', () => {
    expect(
      computeWorkloadBudget({
        limits: [undefined],
        memTotalBytes: 6 * GIB,
        reserveBytes: RESERVE_BYTES,
      })
    ).toEqual({
      ok: true,
      containerLimitBytes: 6 * GIB,
      aggregateMaxBytes: 4096 * MIB,
      source: 'meminfo',
    });
    expect(
      computeWorkloadBudget({ limits: [], memTotalBytes: 6 * GIB, reserveBytes: RESERVE_BYTES })
    ).toEqual({
      ok: true,
      containerLimitBytes: 6 * GIB,
      aggregateMaxBytes: 4096 * MIB,
      source: 'meminfo',
    });
    expect(
      computeWorkloadBudget({
        limits: [undefined],
        explicitLimitBytes: 4 * GIB,
        memTotalBytes: 8 * GIB,
        reserveBytes: RESERVE_BYTES,
      })
    ).toEqual({
      ok: true,
      containerLimitBytes: 4 * GIB,
      aggregateMaxBytes: 2048 * MIB,
      source: 'explicit',
    });
  });

  it('reports no_finite_limit without a cgroup, explicit or meminfo limit', () => {
    expect(computeWorkloadBudget({ limits: [undefined], reserveBytes: RESERVE_BYTES })).toEqual({
      ok: false,
      failure: 'no_finite_limit',
    });
  });
});

describe('workload probe', () => {
  it('uses the nearest ancestor that delegates memory by token match', () => {
    const root = makeRoot();
    delegationTree(root);
    const workload = initialize(root, '/a/b');
    expect(workload.enabled).toBe(true);
    expect(workload.failure).toBeUndefined();
    expect(workload.placement?.parentDirectory).toBe(path.join(root, 'a', 'kilo-workloads'));
    expect(workload.placement?.aggregateMaxBytes).toBe(4 * GIB);
  });

  it('places when the delegated ancestor is finite and the root memory.max is absent', () => {
    const root = makeRoot();
    writeControl(path.join(root, 'a'), 'cgroup.subtree_control', 'memory');
    writeControl(path.join(root, 'a'), 'memory.max', String(6 * GIB));
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    writeControl(path.join(root, 'a', 'kilo-workloads'), 'cgroup.events', 'populated 0');
    const workload = initialize(root, '/a/b');
    expect(workload.failure).toBeUndefined();
    expect(workload.placement?.parentDirectory).toBe(path.join(root, 'a', 'kilo-workloads'));
    expect(workload.placement?.aggregateMaxBytes).toBe(4 * GIB);
  });

  it('ignores a non-token controller name and falls back to a higher delegating ancestor', () => {
    const root = makeRoot();
    writeControl(path.join(root, 'a'), 'cgroup.subtree_control', 'cpuset cpu memoryfoo');
    writeControl(path.join(root, 'a'), 'memory.max', String(6 * GIB));
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    writeControl(root, 'cgroup.subtree_control', 'memory');
    writeControl(root, 'memory.max', String(6 * GIB));
    writeControl(path.join(root, 'kilo-workloads'), 'cgroup.events', 'populated 0');
    const workload = initialize(root, '/a/b');
    expect(workload.placement?.parentDirectory).toBe(path.join(root, 'kilo-workloads'));
  });

  it('falls back to not_delegated when the mount root cannot be enabled', () => {
    if (process.getuid?.() === 0) return;
    const root = makeRoot();
    writeControl(root, 'cgroup.subtree_control', 'cpu');
    writeControl(root, 'memory.max', String(6 * GIB));
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    chmodSync(path.join(root, 'cgroup.subtree_control'), 0o444);
    const workload = initialize(root, '/a/b');
    expect(workload).toEqual({ enabled: true, failure: 'not_delegated' });
    expect(workload.placement).toBeUndefined();
    expect(admitControlWorkload(workload)).toBeUndefined();
    expect(existsSync(path.join(root, 'kilo-workloads'))).toBe(false);
  });

  it('does not rewrite the mount root when an ancestor already delegates', () => {
    const root = makeRoot();
    writeControl(root, 'cgroup.subtree_control', 'cpu');
    writeControl(path.join(root, 'a'), 'cgroup.subtree_control', 'memory');
    writeControl(path.join(root, 'a'), 'memory.max', String(6 * GIB));
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    writeControl(path.join(root, 'a', 'kilo-workloads'), 'cgroup.events', 'populated 0');
    const workload = initialize(root, '/a/b');
    expect(workload.failure).toBeUndefined();
    expect(workload.placement?.parentDirectory).toBe(path.join(root, 'a', 'kilo-workloads'));
    expect(readFileSync(path.join(root, 'cgroup.subtree_control'), 'utf8').trim()).toBe('cpu');
  });

  it('self-enables the mount root and places under it for nested membership', () => {
    const root = makeRoot();
    writeControl(root, 'cgroup.subtree_control', 'cpu');
    writeControl(root, 'memory.max', String(6 * GIB));
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    const workload = initialize(root, '/a/b');
    expect(workload.failure).toBeUndefined();
    expect(workload.placement?.parentDirectory).toBe(path.join(root, 'kilo-workloads'));
    expect(workload.placement?.aggregateMaxBytes).toBe(4 * GIB);
    expect(readFileSync(path.join(root, 'cgroup.subtree_control'), 'utf8').trim()).toBe('+memory');
  });

  it('self-enables its own cgroup when membership is the mount root', () => {
    const root = makeRoot();
    writeControl(root, 'cgroup.subtree_control', 'cpu');
    writeControl(root, 'memory.max', String(6 * GIB));
    const workload = initialize(root, '/');
    expect(workload.failure).toBeUndefined();
    expect(workload.placement?.parentDirectory).toBe(path.join(root, 'kilo-workloads'));
    expect(readFileSync(path.join(root, 'cgroup.subtree_control'), 'utf8').trim()).toBe('+memory');
    expect(existsSync(path.join(root, 'kilo-runtime'))).toBe(false);
  });

  it('does not evacuate when the mount root already delegates memory', () => {
    const root = makeRoot();
    writeControl(root, 'cgroup.subtree_control', 'memory cpu');
    writeControl(root, 'cgroup.procs', '4242\n');
    writeControl(root, 'memory.max', 'max');
    const workload = initialize(root, '/', { CONTROL_WORKLOAD_LIMIT_MB: '12288' });
    expect(workload.failure).toBeUndefined();
    expect(workload.placement?.parentDirectory).toBe(path.join(root, 'kilo-workloads'));
    expect(readFileSync(path.join(root, 'cgroup.procs'), 'utf8')).toBe('4242\n');
    expect(existsSync(path.join(root, 'kilo-runtime'))).toBe(false);
  });

  it('evacuates a populated mount root into kilo-runtime as a last resort', () => {
    const root = makeRoot();
    writeControl(root, 'cgroup.subtree_control', '');
    writeControl(root, 'cgroup.procs', '4242\n4243\n');
    writeControl(root, 'memory.max', 'max');
    const workload = runWithRootWriteSimulation(root, 'while-populated', () =>
      initialize(root, '/', { CONTROL_WORKLOAD_LIMIT_MB: '12288' })
    ).workload;
    expect(workload.failure).toBeUndefined();
    expect(workload.placement?.parentDirectory).toBe(path.join(root, 'kilo-workloads'));
    expect(workload.placement?.aggregateMaxBytes).toBe(10240 * MIB);
    expect(readFileSync(path.join(root, 'cgroup.subtree_control'), 'utf8')).toContain('memory');
    expect(readFileSync(path.join(root, 'cgroup.procs'), 'utf8').trim()).toBe('');
    expect(readFileSync(path.join(root, 'kilo-runtime', 'cgroup.procs'), 'utf8')).toBe(
      '4242\n4243\n'
    );
    expect(readFileSync(path.join(root, 'kilo-workloads', 'memory.max'), 'utf8')).toBe(
      String(10240 * MIB)
    );
    expect(existsSync(path.join(root, 'kilo-runtime', 'memory.max'))).toBe(false);
  });

  it('fails closed as unavailable when the mount root subtree_control is unreadable', () => {
    if (process.getuid?.() === 0) return;
    const root = makeRoot();
    writeControl(root, 'cgroup.subtree_control', 'cpu');
    writeControl(root, 'cgroup.procs', '4242\n');
    writeControl(root, 'memory.max', 'max');
    chmodSync(path.join(root, 'cgroup.subtree_control'), 0o000);
    const workload = initialize(root, '/', { CONTROL_WORKLOAD_LIMIT_MB: '12288' });
    expect(workload).toEqual({ enabled: true, failure: 'unavailable' });
    expect(readFileSync(path.join(root, 'cgroup.procs'), 'utf8')).toBe('4242\n');
    expect(existsSync(path.join(root, 'kilo-runtime'))).toBe(false);
  });

  it('does not evacuate root processes for a nested membership', () => {
    if (process.getuid?.() === 0) return;
    const root = makeRoot();
    writeControl(root, 'cgroup.subtree_control', 'cpu');
    writeControl(root, 'cgroup.procs', '4242\n');
    writeControl(root, 'memory.max', 'max');
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    chmodSync(path.join(root, 'cgroup.subtree_control'), 0o444);
    const workload = initialize(root, '/a/b');
    expect(workload).toEqual({ enabled: true, failure: 'not_delegated' });
    expect(readFileSync(path.join(root, 'cgroup.procs'), 'utf8')).toBe('4242\n');
    expect(existsSync(path.join(root, 'kilo-runtime'))).toBe(false);
  });

  it('does not adopt a populated or capped kilo-runtime directory', () => {
    if (process.getuid?.() === 0) return;
    const cases: Array<{ memoryMax: string; procs: string }> = [
      { memoryMax: 'max', procs: '999\n' },
      { memoryMax: String(4 * GIB), procs: '' },
    ];
    for (const testCase of cases) {
      const root = makeRoot();
      writeControl(root, 'cgroup.subtree_control', 'cpu');
      writeControl(root, 'cgroup.procs', '4242\n');
      writeControl(root, 'memory.max', 'max');
      writeControl(path.join(root, 'kilo-runtime'), 'memory.max', testCase.memoryMax);
      writeControl(path.join(root, 'kilo-runtime'), 'cgroup.procs', testCase.procs);
      chmodSync(path.join(root, 'cgroup.subtree_control'), 0o444);
      const workload = initialize(root, '/', { CONTROL_WORKLOAD_LIMIT_MB: '12288' });
      expect(workload).toEqual({ enabled: true, failure: 'not_delegated' });
      expect(readFileSync(path.join(root, 'cgroup.procs'), 'utf8')).toBe('4242\n');
      expect(readFileSync(path.join(root, 'kilo-runtime', 'cgroup.procs'), 'utf8')).toBe(
        testCase.procs
      );
      expect(readFileSync(path.join(root, 'kilo-runtime', 'memory.max'), 'utf8')).toBe(
        testCase.memoryMax
      );
    }
  });

  it('does not adopt an existing kilo-runtime without an empty cgroup.procs', () => {
    if (process.getuid?.() === 0) return;
    const root = makeRoot();
    writeControl(root, 'cgroup.subtree_control', 'cpu');
    writeControl(root, 'cgroup.procs', '4242\n');
    writeControl(root, 'memory.max', 'max');
    mkdirSync(path.join(root, 'kilo-runtime'));
    chmodSync(path.join(root, 'cgroup.subtree_control'), 0o444);
    const workload = initialize(root, '/', { CONTROL_WORKLOAD_LIMIT_MB: '12288' });
    expect(workload).toEqual({ enabled: true, failure: 'not_delegated' });
    expect(readFileSync(path.join(root, 'cgroup.procs'), 'utf8')).toBe('4242\n');
    expect(existsSync(path.join(root, 'kilo-runtime', 'cgroup.procs'))).toBe(false);
  });

  it('stays not_delegated without throwing when the root stays unwritable after the move', () => {
    const root = makeRoot();
    writeControl(root, 'cgroup.subtree_control', 'cpu');
    writeControl(root, 'cgroup.procs', '4242\n');
    writeControl(root, 'memory.max', 'max');
    const { workload, subtreeAttempts } = runWithRootWriteSimulation(root, 'always', () =>
      initialize(root, '/', { CONTROL_WORKLOAD_LIMIT_MB: '12288' })
    );
    expect(workload).toEqual({ enabled: true, failure: 'not_delegated' });
    expect(readFileSync(path.join(root, 'cgroup.procs'), 'utf8').trim()).toBe('');
    expect(readFileSync(path.join(root, 'kilo-runtime', 'cgroup.procs'), 'utf8')).toBe('4242\n');
    expect(subtreeAttempts).toBeGreaterThanOrEqual(2);
  });

  it.skipIf(!canUseDisposableCgroup)(
    'applies a finite memory.max in a disposable hierarchy on linux',
    async () => {
      const disposable = tryCreateDisposableCgroup();
      if (disposable === undefined) {
        throw new Error('the disposable cgroup hierarchy became unavailable after the probe');
      }
      let child: ReturnType<typeof spawn> | undefined;
      let workload: ControlWorkload | undefined;
      let selfDirectory: string | undefined;
      try {
        child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          stdio: 'ignore',
        });
        if (child.pid === undefined) {
          throw new Error('the disposable hierarchy child did not start');
        }
        writeFileSync(path.join(disposable, 'cgroup.procs'), String(child.pid));
        selfDirectory = mkdtempSync(path.join(os.tmpdir(), 'workload-self-'));
        const selfFile = path.join(selfDirectory, 'cgroup');
        writeFileSync(selfFile, '0::/\n');
        workload = initializeControlWorkload({
          env: { CONTROL_WORKLOAD_CGROUP: '1', CONTROL_WORKLOAD_LIMIT_MB: '12288' },
          cgroupRoot: disposable,
          selfCgroupFile: selfFile,
          procRoot: '/proc',
          isCgroupMount: () => true,
          platform: 'linux',
        });
        expect(workload.failure).toBeUndefined();
        expect(
          readFileSync(path.join(disposable, 'kilo-workloads', 'memory.max'), 'utf8').trim()
        ).toBe(String(10240 * MIB));
      } finally {
        if (workload !== undefined) closeControlWorkload(workload);
        await stopChild(child);
        await removeCgroupDirectory(path.join(disposable, 'kilo-runtime'));
        await removeCgroupDirectory(path.join(disposable, 'kilo-workloads'));
        await removeCgroupDirectory(disposable);
        if (selfDirectory !== undefined) {
          rmSync(selfDirectory, { recursive: true, force: true });
        }
      }
    }
  );

  it('rejects admission after a self-enabled placement is tampered with', () => {
    const root = makeRoot();
    writeControl(root, 'cgroup.subtree_control', 'cpu');
    writeControl(root, 'memory.max', String(6 * GIB));
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    const workload = initialize(root, '/a/b');
    expect(workload.placement?.parentDirectory).toBe(path.join(root, 'kilo-workloads'));
    writeFileSync(path.join(root, 'kilo-workloads', 'memory.oom.group'), '1');
    expect(admitControlWorkload(workload)).toBeUndefined();
  });

  it('continues the walk when a nearer cgroup.subtree_control is absent', () => {
    const root = makeRoot();
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    writeControl(path.join(root, 'a'), 'memory.max', String(6 * GIB));
    writeControl(root, 'cgroup.subtree_control', 'memory');
    writeControl(root, 'memory.max', String(6 * GIB));
    writeControl(path.join(root, 'kilo-workloads'), 'cgroup.events', 'populated 0');
    const workload = initialize(root, '/a/b');
    expect(workload.failure).toBeUndefined();
    expect(workload.placement?.parentDirectory).toBe(path.join(root, 'kilo-workloads'));
  });

  it('fails closed as unavailable when a nearer cgroup.subtree_control cannot be read', () => {
    if (process.getuid?.() === 0) return;
    const root = makeRoot();
    writeControl(path.join(root, 'a'), 'cgroup.subtree_control', 'memory');
    writeControl(path.join(root, 'a'), 'memory.max', String(6 * GIB));
    writeControl(root, 'cgroup.subtree_control', 'memory');
    writeControl(root, 'memory.max', String(6 * GIB));
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    chmodSync(path.join(root, 'a', 'cgroup.subtree_control'), 0o000);
    const workload = initialize(root, '/a/b');
    expect(workload).toEqual({ enabled: true, failure: 'unavailable' });
    expect(workload.placement).toBeUndefined();
  });

  it('fails closed as no_finite_limit when the delegated ancestor is unbounded', () => {
    const root = makeRoot();
    writeControl(path.join(root, 'a'), 'cgroup.subtree_control', 'memory');
    writeControl(path.join(root, 'a'), 'memory.max', 'max');
    writeControl(root, 'memory.max', 'max');
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    const workload = initialize(root, '/a/b');
    expect(workload).toEqual({ enabled: true, failure: 'no_finite_limit' });
  });

  it('reports no_finite_limit when every governing memory.max is missing or max', () => {
    const root = makeRoot();
    writeControl(path.join(root, 'a'), 'cgroup.subtree_control', 'memory');
    writeControl(path.join(root, 'a'), 'memory.max', 'max');
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    const workload = initialize(root, '/a/b');
    expect(workload).toEqual({ enabled: true, failure: 'no_finite_limit' });
  });

  it('uses the meminfo total when no governing memory.max is finite', () => {
    const root = makeRoot();
    writeControl(path.join(root, 'a'), 'cgroup.subtree_control', 'memory');
    writeControl(path.join(root, 'a'), 'memory.max', 'max');
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    const reports: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const workload = initializeControlWorkload({
      env: { CONTROL_WORKLOAD_CGROUP: '1' },
      report: (event, fields) => reports.push({ event, fields }),
      cgroupRoot: root,
      selfCgroupFile: selfCgroupFile(root, '/a/b'),
      procRoot: procWithMemTotal(root, 6 * 1024 * 1024),
      isCgroupMount: () => true,
      handlePath: (_descriptor, directory) => directory,
      platform: 'linux',
    });
    placements.push(workload);
    expect(workload.failure).toBeUndefined();
    expect(workload.placement?.containerLimitBytes).toBe(6 * GIB);
    expect(workload.placement?.aggregateMaxBytes).toBe(4 * GIB);
    expect(workload.placement?.limitSource).toBe('meminfo');
    const applied = reports.find(entry => entry.fields.phase === 'started');
    expect(applied?.fields.workloadLimitSource).toBe('meminfo');
  });

  it('fails closed without a placement when no finite cgroup limit exists and meminfo is missing or too small', () => {
    for (const memTotalKb of [undefined, 2560 * 1024]) {
      const root = makeRoot();
      writeControl(path.join(root, 'a'), 'cgroup.subtree_control', 'memory');
      writeControl(path.join(root, 'a'), 'memory.max', 'max');
      mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
      const workload = runInitialize({
        root,
        membership: '/a/b',
        env: { CONTROL_WORKLOAD_CGROUP: '1' },
        ...(memTotalKb === undefined ? {} : { procRoot: procWithMemTotal(root, memTotalKb) }),
      });
      expect(workload.placement).toBeUndefined();
      expect(admitControlWorkload(workload)).toBeUndefined();
    }
  });

  it('fails closed as below_minimum when the ancestor limit is too small', () => {
    const root = makeRoot();
    writeControl(path.join(root, 'a'), 'cgroup.subtree_control', 'memory');
    writeControl(path.join(root, 'a'), 'memory.max', String(2560 * MIB));
    writeControl(root, 'memory.max', 'max');
    mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    const workload = initialize(root, '/a/b');
    expect(workload).toEqual({ enabled: true, failure: 'below_minimum' });
  });

  it('lets an explicit limit tighten the ancestor limit', () => {
    const root = makeRoot();
    delegationTree(root);
    writeControl(path.join(root, 'a'), 'memory.max', String(8 * GIB));
    const workload = initialize(root, '/a/b', { CONTROL_WORKLOAD_LIMIT_MB: '3072' });
    expect(workload.placement?.containerLimitBytes).toBe(3 * GIB);
    expect(workload.placement?.aggregateMaxBytes).toBe(1 * GIB);
  });

  it('rejects a reused parent that is already populated', () => {
    const root = makeRoot();
    delegationTree(root);
    writeControl(path.join(root, 'a', 'kilo-workloads'), 'cgroup.events', 'populated 1');
    const workload = initialize(root, '/a/b');
    expect(workload).toEqual({ enabled: true, failure: 'occupied' });
  });

  it('does not treat mocked cgroup files as proof of kernel enforcement', () => {
    const root = makeRoot();
    delegationTree(root);
    const reports: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const workload = initializeControlWorkload({
      env: { CONTROL_WORKLOAD_CGROUP: '1' },
      report: (event, fields) => reports.push({ event, fields }),
      cgroupRoot: root,
      selfCgroupFile: selfCgroupFile(root, '/a/b'),
      isCgroupMount: () => true,
      handlePath: (_descriptor, directory) => directory,
      platform: 'linux',
    });
    placements.push(workload);
    expect(workload.placement?.appliedReadbackBytes).toBe(4 * GIB);
    const applied = reports.find(entry => entry.event === 'control.workload');
    expect(applied?.fields.phase).toBe('started');
    expect(applied?.fields.workloadPhase).toBe('applied');
    expect(applied?.fields.siblingProtection).toBe(false);
    expect(admitControlWorkload(workload)).toBe(workload.placement);
  });

  it('rejects admission when the retained parent control is no longer read back', () => {
    const root = makeRoot();
    delegationTree(root);
    const workload = initialize(root, '/a/b');
    writeFileSync(path.join(root, 'a', 'kilo-workloads', 'memory.oom.group'), '1');
    expect(admitControlWorkload(workload)).toBeUndefined();
  });

  it('rejects admission when a reused parent swap file is no longer zero', () => {
    const root = makeRoot();
    delegationTree(root);
    const workload = initialize(root, '/a/b');
    writeFileSync(path.join(root, 'a', 'kilo-workloads', 'memory.swap.max'), '1');
    expect(admitControlWorkload(workload)).toBeUndefined();
  });

  it('fails closed without a placement when a governing memory.max cannot be read', () => {
    if (process.getuid?.() === 0) return;
    const root = makeRoot();
    delegationTree(root);
    chmodSync(path.join(root, 'a', 'memory.max'), 0o000);
    const workload = initialize(root, '/a/b');
    expect(workload).toEqual({ enabled: true, failure: 'unavailable' });
    expect(workload.placement).toBeUndefined();
  });
});

describe('workload enablement', () => {
  it('attempts enforcement by default on linux when the flag is absent', () => {
    const root = makeRoot();
    delegationTree(root);
    const workload = runInitialize({ root, membership: '/a/b', env: {} });
    expect(workload.enabled).toBe(true);
    expect(workload.placement?.parentDirectory).toBe(path.join(root, 'a', 'kilo-workloads'));
  });

  it('neutralizes a stale memory.max when explicitly disabled', () => {
    const root = makeRoot();
    writeControl(path.join(root, 'a', 'kilo-workloads'), 'memory.max', String(4 * GIB));
    writeControl(path.join(root, 'a', 'kilo-workloads'), 'cpu.weight', '25');
    const workload = runInitialize({
      root,
      membership: '/a/b',
      env: { CONTROL_WORKLOAD_CGROUP: '0' },
    });
    expect(workload).toEqual({ enabled: false });
    expect(readFileSync(path.join(root, 'a', 'kilo-workloads', 'memory.max'), 'utf8').trim()).toBe(
      'max'
    );
    expect(admitControlWorkload(workload)).toBeUndefined();
  });

  it('neutralizes a stale cap under the wrapper own cgroup when explicitly disabled', () => {
    const root = makeRoot();
    const owned = path.join(root, 'a', 'b', 'kilo-workloads');
    writeControl(owned, 'memory.max', String(4 * GIB));
    const workload = runInitialize({
      root,
      membership: '/a/b',
      env: { CONTROL_WORKLOAD_CGROUP: '0' },
    });
    expect(workload).toEqual({ enabled: false });
    expect(readFileSync(path.join(owned, 'memory.max'), 'utf8').trim()).toBe('max');
  });

  it('neutralizes a stale cap at the mount root when membership is the mount root', () => {
    const root = makeRoot();
    const owned = path.join(root, 'kilo-workloads');
    writeControl(owned, 'memory.max', String(4 * GIB));
    const workload = runInitialize({
      root,
      membership: '/',
      env: { CONTROL_WORKLOAD_CGROUP: '0' },
    });
    expect(workload).toEqual({ enabled: false });
    expect(readFileSync(path.join(owned, 'memory.max'), 'utf8').trim()).toBe('max');
  });

  it('resets nested tool limits through the opened directory without following symlinks', () => {
    const root = makeRoot();
    const tools = path.join(root, 'a', 'kilo-workloads', 'tools');
    writeControl(tools, 'memory.max', String(4 * GIB));
    writeControl(tools, 'cpu.weight', '25');
    const outside = path.join(root, 'outside');
    writeControl(outside, 'memory.max', String(7 * GIB));
    symlinkSync(outside, path.join(root, 'a', 'kilo-workloads', 'escape'));
    const workload = runInitialize({
      root,
      membership: '/a/b',
      env: { CONTROL_WORKLOAD_CGROUP: '0' },
    });
    expect(workload).toEqual({ enabled: false });
    expect(readFileSync(path.join(tools, 'memory.max'), 'utf8').trim()).toBe('max');
    expect(readFileSync(path.join(tools, 'cpu.weight'), 'utf8').trim()).toBe('100');
    expect(readFileSync(path.join(outside, 'memory.max'), 'utf8').trim()).toBe(String(7 * GIB));
  });

  it('resets nested tool limits through the opened descriptor on linux', () => {
    if (process.platform !== 'linux') return;
    const root = makeRoot();
    const tools = path.join(root, 'a', 'kilo-workloads', 'tools');
    writeControl(tools, 'memory.max', String(4 * GIB));
    const workload = initializeControlWorkload({
      env: { CONTROL_WORKLOAD_CGROUP: '0' },
      cgroupRoot: root,
      selfCgroupFile: selfCgroupFile(root, '/a/b'),
      isCgroupMount: () => true,
      handlePath: descriptor => `/proc/self/fd/${descriptor}`,
    });
    placements.push(workload);
    expect(workload).toEqual({ enabled: false });
    expect(readFileSync(path.join(tools, 'memory.max'), 'utf8').trim()).toBe('max');
  });

  it('enables for any flag value other than an exact zero', () => {
    for (const value of ['1', 'false', 'off']) {
      const root = makeRoot();
      delegationTree(root);
      const workload = runInitialize({
        root,
        membership: '/a/b',
        env: { CONTROL_WORKLOAD_CGROUP: value },
      });
      expect(workload.placement?.parentDirectory).toBe(path.join(root, 'a', 'kilo-workloads'));
    }
  });

  it('fails closed as unavailable without a placement off linux even by default', () => {
    const root = makeRoot();
    const workload = runInitialize({ root, membership: '/a/b', env: {}, platform: 'darwin' });
    expect(workload).toEqual({ enabled: true, failure: 'unavailable' });
    expect(workload.placement).toBeUndefined();
  });

  it('starts unmanaged for an enabled-by-default failure result from initialization', () => {
    const root = makeRoot();
    const workload = runInitialize({ root, membership: '/a/b', env: {}, platform: 'darwin' });
    expect(workload.failure).toBe('unavailable');
    expect(admitControlWorkload(workload)).toBeUndefined();
  });
});

describe('workload admission', () => {
  it('returns undefined for an absent or disabled workload without verifying', () => {
    expect(admitControlWorkload(undefined)).toBeUndefined();
    expect(admitControlWorkload({ enabled: false })).toBeUndefined();
  });

  it('returns undefined for an enabled workload without a placement', () => {
    expect(admitControlWorkload({ enabled: true })).toBeUndefined();
    expect(admitControlWorkload({ enabled: true, failure: 'unavailable' })).toBeUndefined();
  });

  it('starts unmanaged when not_delegated has no placement', () => {
    expect(admitControlWorkload({ enabled: true, failure: 'not_delegated' })).toBeUndefined();
  });

  it('emits a failed diagnostic and returns undefined when retained admission verification fails', () => {
    const root = makeRoot();
    delegationTree(root);
    const reports: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const workload = initializeControlWorkload({
      env: { CONTROL_WORKLOAD_CGROUP: '1' },
      report: (event, fields) => reports.push({ event, fields }),
      cgroupRoot: root,
      selfCgroupFile: selfCgroupFile(root, '/a/b'),
      isCgroupMount: () => true,
      handlePath: (_descriptor, directory) => directory,
      platform: 'linux',
    });
    placements.push(workload);
    reports.length = 0;
    writeFileSync(path.join(root, 'a', 'kilo-workloads', 'memory.oom.group'), '1');
    expect(admitControlWorkload(workload)).toBeUndefined();
    const failed = reports.find(
      entry => entry.event === 'control.workload' && entry.fields.phase === 'failed'
    );
    expect(failed?.fields.workloadPhase).toBe('failed');
    expect(failed?.fields.workloadFailure).toBe('readback_mismatch');
  });

  it('starts unmanaged and reports failure when managed containment is unavailable', () => {
    const root = makeRoot();
    const directory = path.join(root, 'parent');
    mkdirSync(directory, { recursive: true });
    const parentFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    const stat = fstatSync(parentFd);
    const reports: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const placement: WorkloadPlacement = {
      parentFd,
      parentDev: stat.dev,
      parentIno: stat.ino,
      parentReference: directory,
      parentDirectory: directory,
      aggregateMaxBytes: 1 * GIB,
      appliedReadbackBytes: 1 * GIB,
      containerLimitBytes: 3 * GIB,
      limitSource: 'cgroup',
      cpuWeight: 50,
      cpuController: false,
      sweepIntervalMs: 1000,
      report: (event, fields) => reports.push({ event, fields }),
    };
    let childPid: number | undefined;
    try {
      const scope = createOwnedProcessScope(placement);
      const child = scope.spawn(process.execPath, ['-e', 'process.exit(0)'], {
        cwd: process.cwd(),
        env: process.env,
      });
      childPid = child.pid;
      expect(child.pid).toBeDefined();
      expect(scope.observesOccupancy()).toBe(false);
      const failed = reports.find(
        entry => entry.event === 'control.workload' && entry.fields.phase === 'failed'
      );
      expect(failed?.fields.workloadPhase).toBe('failed');
      expect(failed?.fields.workloadFailure).toBe('unavailable');
    } finally {
      if (childPid !== undefined) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {
          childPid = undefined;
        }
      }
      closeSync(parentFd);
    }
  });
});

describe('workload classification', () => {
  it('classifies the server chain, tool commands, orphans and non-members', () => {
    const table = new Map<number, WorkloadProcessEntry>([
      [100, { pid: 100, ppid: 1, argv: ['/bin/sh', '-c', 'exec kilo serve'] }],
      [101, { pid: 101, ppid: 100, argv: ['/usr/local/bin/kilo', 'serve', '--port=0'] }],
      [102, { pid: 102, ppid: 100, argv: ['bash', '-c', 'npm run build'] }],
      [103, { pid: 103, ppid: 101, argv: ['node', 'node_modules/.bin/tsc'] }],
      [104, { pid: 104, ppid: 1, argv: ['bash', '-c', 'orphaned build'] }],
      [105, { pid: 105, ppid: 100, argv: ['unrelated'] }],
    ]);
    const members = [100, 101, 102, 103, 104];
    const { serverPids, toolPids } = classifyWorkloadMembers(members, table, 100);
    expect(serverPids).toEqual([101]);
    expect(new Set(toolPids)).toEqual(new Set([102, 103, 104]));
    expect(toolPids).not.toContain(105);
  });
});

describe('managed workload limits', () => {
  function managedTree(): { parent: string; server: string; tools: string } {
    const root = makeRoot();
    const parent = path.join(root, 'scope');
    const server = path.join(parent, 'server');
    const tools = path.join(parent, 'tools');
    mkdirSync(server, { recursive: true });
    mkdirSync(tools, { recursive: true });
    return { parent, server, tools };
  }

  const apply = (tree: { parent: string; server: string; tools: string }) =>
    applyManagedWorkloadLimits({
      parentReference: tree.parent,
      serverReference: tree.server,
      toolsReference: tree.tools,
      aggregateMaxBytes: 4 * GIB,
    });

  it('applies the required limits and reports the cpu read-back', () => {
    const tree = managedTree();
    expect(apply(tree)).toEqual({ cpuController: true });
    expect(readFileSync(path.join(tree.tools, 'memory.max'), 'utf8')).toBe(String(4 * GIB));
    expect(readFileSync(path.join(tree.tools, 'memory.oom.group'), 'utf8')).toBe('1');
    expect(readFileSync(path.join(tree.server, 'memory.oom.group'), 'utf8')).toBe('0');
  });

  it('treats a missing swap file and cpu file as non-fatal', () => {
    if (process.getuid?.() === 0) return;
    const tree = managedTree();
    writeFileSync(path.join(tree.tools, 'memory.max'), String(4 * GIB));
    writeFileSync(path.join(tree.tools, 'memory.oom.group'), '1');
    writeFileSync(path.join(tree.server, 'memory.oom.group'), '0');
    chmodSync(tree.tools, 0o555);
    try {
      expect(apply(tree)).toEqual({ cpuController: false });
    } finally {
      chmodSync(tree.tools, 0o755);
    }
  });

  it('fails admission when a required tools read-back disagrees', () => {
    if (process.getuid?.() === 0) return;
    const tree = managedTree();
    writeFileSync(path.join(tree.tools, 'memory.max'), String(2 * GIB));
    chmodSync(path.join(tree.tools, 'memory.max'), 0o444);
    try {
      expect(() => apply(tree)).toThrow();
    } finally {
      chmodSync(path.join(tree.tools, 'memory.max'), 0o644);
    }
  });

  it('fails admission when an existing tools swap file is not zero', () => {
    if (process.getuid?.() === 0) return;
    const tree = managedTree();
    writeFileSync(path.join(tree.tools, 'memory.swap.max'), '1');
    chmodSync(path.join(tree.tools, 'memory.swap.max'), 0o444);
    try {
      expect(() => apply(tree)).toThrow();
    } finally {
      chmodSync(path.join(tree.tools, 'memory.swap.max'), 0o644);
    }
  });
});

describe('workload pressure parsing', () => {
  it('parses integer total counters only', () => {
    const text =
      'some avg10=0.00 avg60=0.00 avg300=0.00 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=45';
    expect(parsePressureTotal(text, 'some')).toBe(123);
    expect(parsePressureTotal(text, 'full')).toBe(45);
  });

  it('omits missing or unparsable pressure', () => {
    expect(parsePressureTotal(undefined, 'some')).toBeUndefined();
    expect(parsePressureTotal('garbage', 'some')).toBeUndefined();
    expect(parsePressureTotal('some avg10=0.00 total=abc', 'some')).toBeUndefined();
  });
});

describe('workload diagnostics', () => {
  it('round-trips through the helper and omits unknown fields rejected by the strict schema', () => {
    const record = createControlDiagnosticRecord(
      'control.workload',
      {
        phase: 'started',
        workloadPhase: 'applied',
        aggregateMaxBytes: 2048 * MIB,
        workloadLimitSource: 'meminfo',
        siblingProtection: false,
        unknownWorkloadField: 'secret',
      },
      Date.now()
    );
    expect(record?.event).toBe('control.workload');
    expect(record?.fields.phase).toBe('started');
    expect(record?.fields.workloadPhase).toBe('applied');
    expect(record?.fields.workloadLimitSource).toBe('meminfo');
    expect(record?.fields).not.toHaveProperty('unknownWorkloadField');
    expect(
      controlDiagnosticRecordSchema.safeParse({
        timestamp: Date.now(),
        event: 'control.workload',
        fields: {
          phase: 'started',
          workloadPhase: 'applied',
          unknownWorkloadField: 'secret',
        },
      }).success
    ).toBe(false);
  });

  it('emits enabled early failures and stays silent when the flag is zero', () => {
    const reports: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const report = (event: string, fields: Record<string, unknown>): void => {
      reports.push({ event, fields });
    };
    const disabled = initializeControlWorkload({
      env: { CONTROL_WORKLOAD_CGROUP: '0' },
      platform: 'darwin',
      report,
    });
    expect(disabled).toEqual({ enabled: false });
    expect(reports).toEqual([]);

    const enabled = initializeControlWorkload({ env: {}, platform: 'darwin', report });
    expect(enabled).toEqual({ enabled: true, failure: 'unavailable' });
    expect(reports).toHaveLength(1);
    expect(reports[0].event).toBe('control.workload');
    expect(reports[0].fields.phase).toBe('failed');
    expect(reports[0].fields.workloadPhase).toBe('failed');
    expect(reports[0].fields.workloadFailure).toBe('unavailable');
  });

  it('deduplicates identical failures but re-emits when oom counts change', () => {
    const reports: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const reporter = createWorkloadReporter((event, fields) => reports.push({ event, fields }));
    reporter.emit('kilo-control-1', {
      phase: 'failed',
      workloadPhase: 'migration',
      workloadFailure: 'pid_changed',
    });
    reporter.emit('kilo-control-1', {
      phase: 'failed',
      workloadPhase: 'migration',
      workloadFailure: 'pid_changed',
    });
    reporter.emit('kilo-control-1', {
      phase: 'failed',
      workloadPhase: 'oom',
      oomKills: 1,
      oomGroupKills: 0,
    });
    reporter.emit('kilo-control-1', {
      phase: 'failed',
      workloadPhase: 'oom',
      oomKills: 1,
      oomGroupKills: 0,
    });
    reporter.emit('kilo-control-1', {
      phase: 'failed',
      workloadPhase: 'oom',
      oomKills: 2,
      oomGroupKills: 0,
    });
    expect(reports).toHaveLength(3);
    expect(reports[0].fields.workloadFailure).toBe('pid_changed');
    expect(reports[1].fields.oomKills).toBe(1);
    expect(reports[2].fields.oomKills).toBe(2);
  });

  it('re-emits changed memory stats and keeps identical stats deduplicated', () => {
    const reports: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const reporter = createWorkloadReporter((event, fields) => reports.push({ event, fields }));
    const emit = (currentBytes: number): void => {
      reporter.emit('kilo-control-1', {
        phase: 'completed',
        workloadPhase: 'stats',
        currentBytes,
      });
    };
    emit(1024);
    emit(1024);
    emit(2048);
    expect(reports).toHaveLength(2);
    expect(reports[0].fields.currentBytes).toBe(1024);
    expect(reports[1].fields.currentBytes).toBe(2048);
    reporter.emit('kilo-control-1', {
      phase: 'completed',
      workloadPhase: 'stats',
      currentBytes: 2048,
      toolCount: 1,
      serverCount: 1,
      migratedCount: 0,
      cpuController: true,
    });
    reporter.emit('kilo-control-1', {
      phase: 'completed',
      workloadPhase: 'stats',
      currentBytes: 2048,
      toolCount: 2,
      serverCount: 1,
      migratedCount: 0,
      cpuController: true,
    });
    expect(reports).toHaveLength(4);
    expect(reports[3].fields.toolCount).toBe(2);
  });
});

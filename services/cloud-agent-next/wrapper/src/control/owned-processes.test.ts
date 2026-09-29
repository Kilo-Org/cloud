import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runProcess } from '../utils.js';
import {
  createOwnedProcessScope,
  classifyDirectProcessState,
  migrateWorkloadProcess,
} from './owned-processes.js';
import {
  closeControlWorkload,
  initializeControlWorkload,
  type ControlWorkload,
  type WorkloadPlacement,
  type WorkloadProcessEntry,
} from './workload-cgroup.js';

const spawned: ReturnType<typeof createOwnedProcessScope>[] = [];
const workloads: ControlWorkload[] = [];
const temporaryDirectories: string[] = [];

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
}

afterEach(async () => {
  await Promise.all(spawned.splice(0).map(scope => scope.stop(Date.now() + 1_000)));
  for (const workload of workloads.splice(0)) closeControlWorkload(workload);
  for (const directory of temporaryDirectories.splice(0)) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
    } catch {
      // Best-effort test cleanup.
    }
  }
});

function workloadPlacement(): WorkloadPlacement | undefined {
  if (process.platform !== 'linux') return undefined;
  const workload = initializeControlWorkload({ env: { CONTROL_WORKLOAD_CGROUP: '1' } });
  workloads.push(workload);
  return workload.placement;
}

function findManagedScope(placement: WorkloadPlacement, before: Set<string>): string | undefined {
  try {
    const name = fs
      .readdirSync(placement.parentReference)
      .find(candidate => candidate.startsWith('kilo-control-') && !before.has(candidate));
    return name ? path.join(placement.parentReference, name) : undefined;
  } catch {
    return undefined;
  }
}

function cgroupPids(pathname: string): number[] {
  try {
    return fs
      .readFileSync(pathname, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => Number(line));
  } catch {
    return [];
  }
}

function recursiveCgroupPids(directory: string): number[] {
  const pids: number[] = [];
  const visit = (current: string): void => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    pids.push(...cgroupPids(path.join(current, 'cgroup.procs')));
    for (const entry of entries) {
      if (entry.isDirectory()) visit(path.join(current, entry.name));
    }
  };
  visit(directory);
  return pids;
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<boolean> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (condition()) return true;
    await Bun.sleep(25);
  }
  return condition();
}

function processDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

const descendantThatExitsMs = (ms: number) =>
  `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${ms})'], { stdio: 'ignore' }); process.stdout.write(String(child.pid)); setTimeout(() => process.exit(0), 20);`;

const immortalDescendant = `const { spawn } = require('node:child_process'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(String(child.pid)); setTimeout(() => process.exit(0), 20);`;

describe('owned process scopes', () => {
  it('coalesces cleanup and treats unavailable containment as unconfirmed', async () => {
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    const child = scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      cwd: process.cwd(),
      env: process.env,
    });
    const exited = once(child, 'exit');
    const first = scope.stop(Date.now() + 1_000);
    const second = scope.stop(Date.now() + 500);

    expect(second).toBe(first);
    const stopped = await first;
    expect(stopped).toBe(await scope.verify(false));
    await exited;
    if (process.platform !== 'linux') expect(await scope.verify(false)).toBe(false);
  });

  it('returns an unmanaged replacement when gate admission fails', async () => {
    if (process.platform !== 'linux') return;
    const membership = readSelfCgroupMembership();
    if (!membership) return;
    const directory = path.join('/sys/fs/cgroup', membership);
    let before: Set<string>;
    try {
      before = new Set(fs.readdirSync(directory));
    } catch {
      return;
    }
    const originalReadFileSync = fs.readFileSync;
    const statFailure = spyOn(fs, 'readFileSync').mockImplementation(((
      target: unknown,
      ...rest: unknown[]
    ): string | Buffer => {
      if (typeof target === 'string' && /^\/proc\/\d+\/stat$/.test(target)) {
        throw Object.assign(new Error('simulated stat read failure'), { code: 'EACCES' });
      }
      return (originalReadFileSync as (value: unknown, ...args: unknown[]) => string | Buffer)(
        target,
        ...rest
      );
    }) as typeof fs.readFileSync);
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    const children: ChildProcess[] = [];
    let created: string | undefined;
    try {
      const child = scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
        cwd: process.cwd(),
        env: process.env,
      });
      children.push(child);
      created = fs
        .readdirSync(directory)
        .find(name => name.startsWith('kilo-control-') && !before.has(name));
      if (!created) return;
      expect(child.spawnfile).toBe(process.execPath);
      expect(child.spawnfile).not.toBe('/bin/sh');
      expect(child.pid).toBeDefined();
      expect(scope.observesOccupancy()).toBe(false);
      const later = scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
        cwd: process.cwd(),
        env: process.env,
      });
      children.push(later);
      expect(later.spawnfile).toBe(process.execPath);
      expect(later.spawnfile).not.toBe('/bin/sh');
      await scope.stop(Date.now() + 5_000);
      scope.releaseAbandoned();
    } finally {
      statFailure.mockRestore();
      for (const child of children) {
        if (child.pid !== undefined) killPid(child.pid);
      }
      if (created) {
        try {
          fs.rmdirSync(path.join(directory, created));
        } catch {
          console.warn('Owned process gate failure cleanup failed');
        }
      }
    }
  });

  it('does not return the gated shell when a gate release write fails without placement', async () => {
    if (process.platform !== 'linux') return;
    const membership = readSelfCgroupMembership();
    if (!membership) return;
    const directory = path.join('/sys/fs/cgroup', membership);
    let before: Set<string>;
    try {
      before = new Set(fs.readdirSync(directory));
    } catch {
      return;
    }
    const originalWriteSync = fs.writeSync;
    const gateFailure = spyOn(fs, 'writeSync').mockImplementation(((
      target: unknown,
      ...rest: unknown[]
    ): number => {
      if (rest[0] === 'start\n') {
        throw Object.assign(new Error('simulated gate release failure'), { code: 'EPIPE' });
      }
      return (originalWriteSync as (value: unknown, ...args: unknown[]) => number)(target, ...rest);
    }) as typeof fs.writeSync);
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    let created: string | undefined;
    let replacement: ChildProcess | undefined;
    try {
      const child = scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
        cwd: process.cwd(),
        env: process.env,
      });
      replacement = child;
      created = fs
        .readdirSync(directory)
        .find(name => name.startsWith('kilo-control-') && !before.has(name));
      if (!created) return;
      expect(child.spawnfile).toBe(process.execPath);
      expect(child.spawnfile).not.toBe('/bin/sh');
      expect(child.pid).toBeDefined();
      expect(scope.observesOccupancy()).toBe(false);
      await scope.stop(Date.now() + 5_000);
      scope.releaseAbandoned();
      expect(await waitFor(() => processDead(child.pid as number))).toBe(true);
    } finally {
      gateFailure.mockRestore();
      if (replacement?.pid !== undefined) killPid(replacement.pid);
      if (created) {
        try {
          fs.rmdirSync(path.join(directory, created));
        } catch {
          console.warn('Owned process gate failure cleanup failed');
        }
      }
    }
  });

  it('returns an unmanaged replacement when the gate release write fails', async () => {
    const placement = workloadPlacement();
    if (!placement) return;
    const before = new Set(
      fs.readdirSync(placement.parentReference).filter(name => name.startsWith('kilo-control-'))
    );
    const originalWriteSync = fs.writeSync;
    const gateFailure = spyOn(fs, 'writeSync').mockImplementation(((
      target: unknown,
      ...rest: unknown[]
    ): number => {
      if (rest[0] === 'start\n') {
        throw Object.assign(new Error('simulated gate release failure'), { code: 'EPIPE' });
      }
      return (originalWriteSync as (value: unknown, ...args: unknown[]) => number)(target, ...rest);
    }) as typeof fs.writeSync);
    const scope = createOwnedProcessScope(placement);
    spawned.push(scope);
    try {
      const child = scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
        cwd: process.cwd(),
        env: process.env,
      });
      expect(child.spawnfile).toBe(process.execPath);
      expect(scope.observesOccupancy()).toBe(false);
      await scope.stop(Date.now() + 5_000);
      scope.releaseAbandoned();
      expect(await waitFor(() => processDead(child.pid as number))).toBe(true);
    } finally {
      gateFailure.mockRestore();
      const owned = findManagedScope(placement, before);
      if (owned) {
        try {
          fs.rmSync(owned, { recursive: true, force: true });
        } catch {
          console.warn('Owned process gate failure cleanup failed');
        }
      }
    }
  });

  it('keeps proven death after a bounded cgroup removal failure on Linux', async () => {
    if (process.platform !== 'linux') return;
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    const child = scope.spawn(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: process.cwd(),
      env: process.env,
    });
    await once(child, 'exit');
    if (!scope.observesOccupancy()) return;
    const removal = spyOn(fs, 'rmdirSync').mockImplementation(() => {
      throw new Error('simulated cgroup removal failure');
    });
    try {
      expect(await scope.stop(Date.now() + 1_000)).toBe(true);
      const deadlineAt = Date.now() + 1_000;
      while (removal.mock.calls.length === 0 && Date.now() < deadlineAt) await Bun.sleep(5);
      expect(removal).toHaveBeenCalled();
      expect(await scope.verify(false)).toBe(true);
    } finally {
      removal.mockRestore();
    }
  });

  it('removes a delayed descendant that outlives its tracked parent when containment is available', async () => {
    if (process.platform !== 'linux') return;
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    const parent = scope.spawn(
      process.execPath,
      [
        '-e',
        "const { spawn } = require('node:child_process'); setTimeout(() => { const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write(String(child.pid)); setTimeout(() => process.exit(0), 20); }, 20);",
      ],
      { cwd: process.cwd(), env: process.env }
    );
    let output = '';
    parent.stdout.on('data', data => {
      output += data.toString();
    });
    await once(parent, 'exit');
    const descendant = Number(output);
    expect(Number.isSafeInteger(descendant)).toBe(true);

    if (!(await scope.stop(Date.now() + 1_000))) {
      killPid(descendant);
      return;
    }
    expect(() => process.kill(descendant, 0)).toThrow();
  });

  it('keeps occupancy after a successful parent exit until descendants are gone on Linux', async () => {
    if (process.platform !== 'linux') return;
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    let descendant = 0;
    try {
      const result = await scope.run(() =>
        runProcess(process.execPath, ['-e', immortalDescendant], { timeoutMs: 400 })
      );
      descendant = Number(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
      if (!scope.observesOccupancy()) return;
      expect(await scope.verify(false)).toBe(false);
      expect(scope.dispose()).toBe(false);
      killPid(descendant);
      const deadlineAt = Date.now() + 1_000;
      while (Date.now() < deadlineAt && !(await scope.verify(false))) {
        await Bun.sleep(25);
      }
      expect(await scope.verify(false)).toBe(true);
    } finally {
      if (descendant > 0) killPid(descendant);
    }
  });

  it('waits for a short-lived descendant before treating runProcess as complete on Linux', async () => {
    if (process.platform !== 'linux') return;
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    let descendant = 0;
    try {
      const startedAt = Date.now();
      const result = await scope.run(() =>
        runProcess(process.execPath, ['-e', descendantThatExitsMs(250)], { timeoutMs: 2_000 })
      );
      descendant = Number(result.stdout);
      expect(result.exitCode).toBe(0);
      if (!scope.observesOccupancy()) return;
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(200);
      expect(await scope.verify(false)).toBe(true);
    } finally {
      if (descendant > 0) killPid(descendant);
    }
  });

  it('does not wait for Darwin occupancy after the tracked parent exits', async () => {
    if (process.platform === 'linux') return;
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    let descendant = 0;
    try {
      const startedAt = Date.now();
      const result = await scope.run(() =>
        runProcess(process.execPath, ['-e', immortalDescendant], { timeoutMs: 2_000 })
      );
      descendant = Number(result.stdout);
      expect(result.exitCode).toBe(0);
      expect(Number.isSafeInteger(descendant) && descendant > 0).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(await scope.verify(false)).toBe(false);
    } finally {
      if (descendant > 0) killPid(descendant);
    }
  });

  it('does not wait out timeoutMs after close when occupancy is unobservable', async () => {
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    const result = await scope.run(async () => {
      const ungated = scope.spawn('/bin/true', [], {
        cwd: process.cwd(),
        env: process.env,
        shell: true,
      });
      await once(ungated, 'close');
      expect(scope.observesOccupancy()).toBe(false);
      const startedAt = Date.now();
      const completed = await runProcess(process.execPath, ['-e', 'process.exit(0)'], {
        timeoutMs: 2_000,
      });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      return completed;
    });
    expect(result.exitCode).toBe(0);
  });

  it('observes a directly spawned child as alive until it exits', async () => {
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    const child = scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      cwd: process.cwd(),
      env: process.env,
    });
    const observer = scope.observeChild(child);
    expect(observer).toBeDefined();
    expect(await observer?.observe()).toBe('alive');
    child.kill('SIGKILL');
    await once(child, 'exit');
    expect(await observer?.observe()).toBe('absent');
  });

  it('does not treat a released scope as proven cleanup', async () => {
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    const child = scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      cwd: process.cwd(),
      env: process.env,
    });
    try {
      scope.releaseAbandoned();
      expect(await scope.verify(false)).toBe(false);
      expect(scope.dispose()).toBe(false);
    } finally {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
  });

  it('releases inherited child streams for an abandoned scope across repeated replacements', async () => {
    for (let index = 0; index < 2; index += 1) {
      const scope = createOwnedProcessScope();
      spawned.push(scope);
      const child = scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
        cwd: process.cwd(),
        env: process.env,
      });
      try {
        expect(child.stdout.destroyed).toBe(false);
        expect(child.stderr.destroyed).toBe(false);
        scope.releaseAbandoned();
        scope.releaseAbandoned();
        expect(child.stdout.destroyed).toBe(true);
        expect(child.stderr.destroyed).toBe(true);
        expect(child.stdin.destroyed).toBe(true);
        expect(await scope.verify(false)).toBe(false);
        expect(scope.dispose()).toBe(false);
      } finally {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });

  describe('direct process observation classification', () => {
    it('classifies a changed start identity as reused instead of alive', () => {
      const pid = 4321;
      const live = '4321 (kilo) S 1 4321 4321 0 -1 4194304 100 0 0 0 1 2 0 0 20 0 1 0 111 0 0';
      const reused = '4321 (kilo) S 1 4321 4321 0 -1 4194304 100 0 0 0 1 2 0 0 20 0 1 0 222 0 0';
      expect(
        classifyDirectProcessState({
          exited: false,
          pid,
          platform: 'linux',
          storedIdentity: `${pid}:111`,
          statText: live,
        })
      ).toBe('alive');
      expect(
        classifyDirectProcessState({
          exited: false,
          pid,
          platform: 'linux',
          storedIdentity: `${pid}:111`,
          statText: reused,
        })
      ).toBe('reused');
      expect(
        classifyDirectProcessState({
          exited: false,
          pid,
          platform: 'linux',
          storedIdentity: undefined,
          statText: live,
        })
      ).toBe('unknown');
    });

    it('treats only positively established absence as absent on the non-Linux probe', () => {
      const missing = Object.assign(new Error('missing'), {
        code: 'ESRCH',
      }) as NodeJS.ErrnoException;
      const denied = Object.assign(new Error('denied'), {
        code: 'EPERM',
      }) as NodeJS.ErrnoException;
      expect(
        classifyDirectProcessState({
          exited: false,
          pid: 99,
          platform: 'darwin',
          storedIdentity: undefined,
        })
      ).toBe('alive');
      expect(
        classifyDirectProcessState({
          exited: false,
          pid: 99,
          platform: 'darwin',
          storedIdentity: undefined,
          probeError: missing,
        })
      ).toBe('absent');
      expect(
        classifyDirectProcessState({
          exited: false,
          pid: 99,
          platform: 'darwin',
          storedIdentity: undefined,
          probeError: denied,
        })
      ).toBe('unknown');
    });
  });
});

describe('workload migration step', () => {
  const entry: WorkloadProcessEntry = { pid: 7, ppid: 1, argv: ['bash', '-c', 'build'] };

  it('checks identity immediately before the write', async () => {
    const calls: string[] = [];
    const outcome = await migrateWorkloadProcess({
      pid: entry.pid,
      entry,
      procRoot: '/proc',
      identityMatches: async () => {
        calls.push('check');
        return true;
      },
      write: () => {
        calls.push('write');
      },
      confirmMembership: async () => true,
    });
    expect(outcome).toBe('migrated');
    expect(calls).toEqual(['check', 'write']);
  });

  it('skips the write and reports pid_changed when the identity changed after selection', async () => {
    const writes: number[] = [];
    const outcome = await migrateWorkloadProcess({
      pid: entry.pid,
      entry,
      procRoot: '/proc',
      identityMatches: async () => false,
      write: pid => writes.push(pid),
      confirmMembership: async () => true,
    });
    expect(outcome).toBe('pid_changed');
    expect(writes).toEqual([]);
  });

  it('reports pid_changed without writing when the process left the snapshot', async () => {
    const writes: number[] = [];
    const outcome = await migrateWorkloadProcess({
      pid: entry.pid,
      entry: undefined,
      procRoot: '/proc',
      write: pid => writes.push(pid),
      confirmMembership: async () => true,
    });
    expect(outcome).toBe('pid_changed');
    expect(writes).toEqual([]);
  });

  it('reports membership_unconfirmed when the write is not reflected', async () => {
    const outcome = await migrateWorkloadProcess({
      pid: entry.pid,
      entry,
      procRoot: '/proc',
      identityMatches: async () => true,
      write: () => undefined,
      confirmMembership: async () => false,
    });
    expect(outcome).toBe('membership_unconfirmed');
  });
});

function readSelfCgroupMembership(): string | undefined {
  try {
    const line = fs
      .readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find(candidate => candidate.startsWith('0::'));
    const membership = line?.slice(3);
    return membership && membership.startsWith('/') ? membership : undefined;
  } catch {
    return undefined;
  }
}

describe('workload cgroup integration', () => {
  it('keeps a managed scope under the workload parent and splits server from tools', async () => {
    const placement = workloadPlacement();
    if (!placement) return;
    const before = new Set(
      fs.readdirSync(placement.parentReference).filter(name => name.startsWith('kilo-control-'))
    );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workload-owned-'));
    temporaryDirectories.push(directory);
    const toolPidFile = path.join(directory, 'tool.pid');
    const kilo = path.join(directory, 'kilo');
    fs.writeFileSync(kilo, `#!/bin/sh\nsleep 30 &\necho $! > ${toolPidFile}\nwait\n`, {
      mode: 0o755,
    });

    const scope = createOwnedProcessScope(placement);
    spawned.push(scope);
    const server = scope.spawn(kilo, ['serve', '--port=0'], { cwd: directory, env: process.env });
    if (!scope.observesOccupancy()) return;
    const serverPid = server.pid;
    expect(serverPid).toBeDefined();
    if (serverPid === undefined) return;

    const owned = findManagedScope(placement, before);
    expect(owned).toBeDefined();
    if (!owned) return;

    expect(
      await waitFor(() =>
        cgroupPids(path.join(owned, 'server', 'cgroup.procs')).includes(serverPid)
      )
    ).toBe(true);
    expect(
      await waitFor(() => {
        try {
          return Number(fs.readFileSync(toolPidFile, 'utf8').trim()) > 0;
        } catch {
          return false;
        }
      })
    ).toBe(true);
    const toolPid = Number(fs.readFileSync(toolPidFile, 'utf8').trim());
    expect(
      await waitFor(() => cgroupPids(path.join(owned, 'tools', 'cgroup.procs')).includes(toolPid))
    ).toBe(true);

    expect(cgroupPids(path.join(owned, 'server', 'cgroup.procs'))).not.toContain(toolPid);
    expect(recursiveCgroupPids(owned)).toEqual(expect.arrayContaining([serverPid, toolPid]));
    expect(
      fs.readFileSync(path.join(placement.parentReference, 'memory.oom.group'), 'utf8').trim()
    ).toBe('0');
    expect(await scope.verify(false)).toBe(false);

    expect(await scope.stop(Date.now() + 5_000)).toBe(true);
    expect(await waitFor(() => processDead(serverPid) && processDead(toolPid))).toBe(true);
    expect(await waitFor(() => !fs.existsSync(owned))).toBe(true);
  });

  it('moves a kilo serve process born in the tools group back to server', async () => {
    const placement = workloadPlacement();
    if (!placement) return;
    const before = new Set(
      fs.readdirSync(placement.parentReference).filter(name => name.startsWith('kilo-control-'))
    );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workload-owned-'));
    temporaryDirectories.push(directory);
    const kilo = path.join(directory, 'kilo');
    const tool = path.join(directory, 'tool.sh');
    const nestedPidFile = path.join(directory, 'nested.pid');
    fs.writeFileSync(
      tool,
      `#!/bin/sh\nwhile ! grep -q /tools /proc/self/cgroup; do sleep 0.1; done\n"${kilo}" serve --from-tool &\necho $! > "${nestedPidFile}"\nsleep 30\n`,
      { mode: 0o755 }
    );
    fs.writeFileSync(
      kilo,
      `#!/bin/sh\nif [ "$2" = --from-tool ]; then sleep 30; exit; fi\n"${tool}" &\nwait\n`,
      { mode: 0o755 }
    );
    const scope = createOwnedProcessScope(placement);
    spawned.push(scope);
    const server = scope.spawn(kilo, ['serve', '--port=0'], { cwd: directory, env: process.env });
    if (!scope.observesOccupancy()) return;
    const owned = findManagedScope(placement, before);
    expect(owned).toBeDefined();
    if (!owned) return;
    expect(
      await waitFor(() => {
        try {
          return Number(fs.readFileSync(nestedPidFile, 'utf8').trim()) > 0;
        } catch {
          return false;
        }
      })
    ).toBe(true);
    const nestedPid = Number(fs.readFileSync(nestedPidFile, 'utf8').trim());
    expect(
      await waitFor(() =>
        cgroupPids(path.join(owned, 'server', 'cgroup.procs')).includes(nestedPid)
      )
    ).toBe(true);
    expect(cgroupPids(path.join(owned, 'tools', 'cgroup.procs'))).not.toContain(nestedPid);
    expect(server.pid).toBeDefined();
  });

  it('does not create workload children for an unmanaged scope', async () => {
    if (process.platform !== 'linux') return;
    const membership = readSelfCgroupMembership();
    if (!membership) return;
    const directory = path.join('/sys/fs/cgroup', membership);
    const before = new Set(
      fs.readdirSync(directory).filter(name => name.startsWith('kilo-control-'))
    );
    const scope = createOwnedProcessScope();
    spawned.push(scope);
    const child = scope.spawn(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: process.cwd(),
      env: process.env,
    });
    await once(child, 'exit');
    if (!scope.observesOccupancy()) return;
    for (const name of fs.readdirSync(directory)) {
      if (!name.startsWith('kilo-control-') || before.has(name)) continue;
      expect(fs.existsSync(path.join(directory, name, 'server'))).toBe(false);
      expect(fs.existsSync(path.join(directory, name, 'tools'))).toBe(false);
    }
  });

  it('reports the tools cpu read-back in the managed scope stats diagnostic', async () => {
    if (process.platform !== 'linux') return;
    const reports: Array<{ event: string; fields: Record<string, unknown> }> = [];
    const workload = initializeControlWorkload({
      env: { CONTROL_WORKLOAD_CGROUP: '1' },
      report: (event, fields) => reports.push({ event, fields }),
    });
    workloads.push(workload);
    const placement = workload.placement;
    if (!placement) return;
    const scope = createOwnedProcessScope(placement);
    spawned.push(scope);
    scope.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      cwd: process.cwd(),
      env: process.env,
    });
    if (!scope.observesOccupancy()) return;
    await waitFor(() => reports.some(entry => entry.fields.workloadPhase === 'stats'));
    const stats = reports.find(entry => entry.fields.workloadPhase === 'stats');
    expect(stats?.event).toBe('control.workload');
    expect(typeof stats?.fields.cpuController).toBe('boolean');
    expect(await scope.stop(Date.now() + 1_000)).toBe(true);
  });
});

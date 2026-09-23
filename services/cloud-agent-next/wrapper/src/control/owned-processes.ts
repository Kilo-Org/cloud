import { AsyncLocalStorage } from 'node:async_hooks';
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statfsSync,
  writeSync,
} from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { pidStillMatches, readProcessTable } from '../tool-cgroup.js';
import {
  applyManagedWorkloadLimits,
  CGROUP_FS_MAGIC,
  classifyWorkloadMembers,
  createWorkloadReporter,
  readWorkloadStats,
  WORKLOAD_SERVER_NAME,
  WORKLOAD_SWEEP_INTERVAL_MS,
  WORKLOAD_TOOLS_NAME,
  type WorkloadPlacement,
  type WorkloadProcessEntry,
} from './workload-cgroup.js';

export type DirectProcessState = 'absent' | 'reused' | 'alive' | 'unknown';

export type DirectProcessObserver = {
  observe(deadlineAt?: number): Promise<DirectProcessState>;
};

export type OwnedProcessScope = {
  spawn(
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio
  ): ChildProcessWithoutNullStreams;
  observeChild(process: ChildProcessWithoutNullStreams): DirectProcessObserver | undefined;
  releaseAbandoned(): void;
  run<T>(operation: () => T): T;
  seal(): void;
  dispose(): boolean;
  observesOccupancy(): boolean;
  captureBaseline(allowed: (argv: string[]) => boolean, deadlineAt?: number): Promise<void>;
  verify(baseline?: boolean, deadlineAt?: number): Promise<boolean>;
  stop(deadlineAt: number): Promise<boolean>;
};

type ProcessIdentity = {
  pid: number;
  parent: number;
  group: number;
  identity: string;
  state: string;
};
type OwnedChild = {
  process: ChildProcessWithoutNullStreams;
  identity?: string;
  exited: boolean;
  gate?: Writable;
};
type Cgroup = {
  directory: string;
  reference: string;
  dev: number;
  ino: number;
  descriptors: number[];
  procs: number;
  procsReference: string;
  kill?: number;
  managed?: {
    serverReference: string;
    toolsReference: string;
    toolsProcs: number;
    cpuController: boolean;
  };
};

export const OWNED_PROCESS_OBSERVATION_TIMEOUT_MS = 1_000;
const OBSERVATION_TIMEOUT_MS = OWNED_PROCESS_OBSERVATION_TIMEOUT_MS;
const current = new AsyncLocalStorage<OwnedProcessScope>();

export function currentOwnedProcessScope(): OwnedProcessScope | undefined {
  return current.getStore();
}

function assertBefore(deadlineAt: number): void {
  if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) {
    throw new Error('Owned process deadline expired');
  }
}

function createDeadline(initialDeadlineAt: number) {
  let deadlineAt = initialDeadlineAt;
  const controller = new AbortController();
  const expiration = Promise.withResolvers<never>();
  void expiration.promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expire = (): void => {
    controller.abort();
    expiration.reject(new Error('Owned process deadline expired'));
  };
  const arm = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (!Number.isFinite(deadlineAt) || Date.now() >= deadlineAt) expire();
    else timer = setTimeout(expire, deadlineAt - Date.now());
  };
  const check = (): void => {
    assertBefore(deadlineAt);
    controller.signal.throwIfAborted();
  };
  arm();
  return {
    check,
    get deadlineAt() {
      return deadlineAt;
    },
    shorten(next: number) {
      deadlineAt = Math.min(deadlineAt, next);
      if (!controller.signal.aborted) arm();
    },
    async wait<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      check();
      const value = await Promise.race([operation(controller.signal), expiration.promise]);
      check();
      return value;
    },
    close() {
      if (timer !== undefined) clearTimeout(timer);
      expire();
    },
  };
}

type Deadline = ReturnType<typeof createDeadline>;

function parsePids(value: string): number[] {
  return value
    .split('\n')
    .filter(Boolean)
    .map(value => {
      const pid = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error('Invalid process membership');
      }
      return pid;
    });
}

function population(value: string): number {
  const entries = value.split('\n').filter(line => line.startsWith('populated '));
  if (entries.length !== 1 || !/^populated [01]$/.test(entries[0])) {
    throw new Error('Process containment unavailable');
  }
  return Number(entries[0].slice('populated '.length));
}

function processIdentity(pid: number, value: string): ProcessIdentity {
  if (!value.startsWith(`${pid} (`) || !value.includes(') ')) {
    throw new Error('Process identity unavailable');
  }
  const fields = value
    .slice(value.lastIndexOf(')') + 2)
    .trim()
    .split(/\s+/);
  const state = fields[0];
  const startedAt = fields[19];
  const parent = Number(fields[1]);
  const group = Number(fields[2]);
  if (
    !state ||
    !/^[A-Za-z]$/.test(state) ||
    !startedAt ||
    !/^\d+$/.test(startedAt) ||
    !Number.isSafeInteger(parent) ||
    parent < 0 ||
    !Number.isSafeInteger(group) ||
    group <= 0
  ) {
    throw new Error('Process identity unavailable');
  }
  return { pid, parent, group, identity: `${pid}:${startedAt}`, state };
}

function isLiveProcessState(state: string): boolean {
  return state !== 'Z' && state !== 'X' && state !== 'x';
}

export function classifyDirectProcessState(input: {
  exited: boolean;
  pid: number | undefined;
  platform: NodeJS.Platform;
  storedIdentity: string | undefined;
  statText?: string;
  probeError?: NodeJS.ErrnoException;
}): DirectProcessState {
  if (input.exited || input.pid === undefined) return 'absent';
  if (input.platform !== 'linux') {
    if (!input.probeError) return 'alive';
    return input.probeError.code === 'ESRCH' ? 'absent' : 'unknown';
  }
  if (input.probeError) {
    return input.probeError.code === 'ENOENT' ? 'absent' : 'unknown';
  }
  try {
    const fresh = processIdentity(input.pid, input.statText ?? '');
    if (!isLiveProcessState(fresh.state)) return 'absent';
    if (!input.storedIdentity) return 'unknown';
    return fresh.identity === input.storedIdentity ? 'alive' : 'reused';
  } catch {
    return 'unknown';
  }
}

function closeDescriptors(descriptors: number[]): void {
  for (const descriptor of descriptors.splice(0)) {
    try {
      closeSync(descriptor);
    } catch {
      console.warn('Owned process descriptor close failed; continuing descriptor cleanup');
    }
  }
}

function releaseChildStreams(child: OwnedChild): void {
  for (const stream of [child.process.stdin, child.process.stdout, child.process.stderr]) {
    try {
      stream.destroy();
    } catch {
      console.warn('Owned process child stream release failed; continuing stream cleanup');
    }
  }
  if (child.gate) {
    try {
      child.gate.destroy();
    } catch {
      console.warn('Owned process child stream release failed; continuing stream cleanup');
    }
  }
}

function releaseGate(gate: Writable): void {
  const fd = (gate as Writable & { _handle?: { fd?: number } })._handle?.fd;
  if (typeof fd !== 'number') throw new Error('Owned child gate unavailable');
  writeSync(fd, 'start\n');
  gate.destroy();
}

function isErofs(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EROFS';
}

function remountCgroupWritable(target: string): void {
  spawnSync('mount', ['-o', 'remount,rw', target], { stdio: 'ignore' });
}

function createCgroup(): Cgroup | undefined {
  const descriptors: number[] = [];
  let created: { directory: string; dev: number; ino: number } | undefined;
  try {
    if (process.platform !== 'linux') return undefined;
    const membership = readFileSync('/proc/self/cgroup', 'utf8')
      .split('\n')
      .find(line => line.startsWith('0::'))
      ?.slice(3);
    if (
      !membership ||
      !path.posix.isAbsolute(membership) ||
      path.posix.normalize(membership) !== membership
    ) {
      return undefined;
    }
    const parent = path.join('/sys/fs/cgroup', membership);
    const parentFd = openSync(
      parent,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    descriptors.push(parentFd);
    const parentReference = `/proc/self/fd/${parentFd}`;
    if (
      statfsSync(parentReference).type !== 0x63677270 ||
      !parsePids(readFileSync(path.join(parentReference, 'cgroup.procs'), 'utf8')).includes(
        process.pid
      )
    ) {
      throw new Error('Process containment root unavailable');
    }
    const parentProcs = path.join(parentReference, 'cgroup.procs');
    try {
      descriptors.push(openSync(parentProcs, constants.O_WRONLY | constants.O_NOFOLLOW));
    } catch (error) {
      if (!isErofs(error)) throw error;
      remountCgroupWritable(parent);
      descriptors.push(openSync(parentProcs, constants.O_WRONLY | constants.O_NOFOLLOW));
    }
    const name = `kilo-control-${crypto.randomUUID()}`;
    try {
      mkdirSync(path.join(parentReference, name));
    } catch (error) {
      if (!isErofs(error)) throw error;
      remountCgroupWritable(parent);
      mkdirSync(path.join(parentReference, name));
    }
    const directory = path.join(parent, name);
    const descriptor = openSync(
      path.join(parentReference, name),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    descriptors.push(descriptor);
    const { dev, ino } = fstatSync(descriptor);
    created = { directory, dev, ino };
    const reference = `/proc/self/fd/${descriptor}`;
    if (population(readFileSync(path.join(reference, 'cgroup.events'), 'utf8')) !== 0) {
      throw new Error('Owned process containment is occupied');
    }
    const procs = openSync(
      path.join(reference, 'cgroup.procs'),
      constants.O_WRONLY | constants.O_NOFOLLOW
    );
    descriptors.push(procs);
    let kill: number | undefined;
    try {
      kill = openSync(
        path.join(reference, 'cgroup.kill'),
        constants.O_WRONLY | constants.O_NOFOLLOW
      );
      descriptors.push(kill);
    } catch {
      console.warn('Owned process cgroup.kill unavailable; using verified child signals');
    }
    closeDescriptors(descriptors.splice(0, 2));
    return { directory, reference, dev, ino, descriptors, procs, procsReference: reference, kill };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    console.warn(`Owned process containment unavailable: ${message}`);
    if (created) {
      try {
        const fresh = lstatSync(created.directory);
        if (fresh.dev === created.dev && fresh.ino === created.ino) rmdirSync(created.directory);
      } catch {
        console.warn('Owned process containment creation cleanup failed');
      }
    }
    closeDescriptors(descriptors);
    return undefined;
  }
}

function sameDirectory(group: Cgroup, value: { dev: number; ino: number }): boolean {
  return value.dev === group.dev && value.ino === group.ino;
}

export type WorkloadMigrationOutcome =
  | 'migrated'
  | 'pid_changed'
  | 'write_failed'
  | 'membership_unconfirmed';

export async function migrateWorkloadProcess(input: {
  pid: number;
  entry: WorkloadProcessEntry | undefined;
  procRoot: string;
  write: (pid: number) => void;
  confirmMembership: () => Promise<boolean>;
  identityMatches?: (procRoot: string, entry: WorkloadProcessEntry) => Promise<boolean>;
}): Promise<WorkloadMigrationOutcome> {
  const matches = input.identityMatches ?? pidStillMatches;
  if (!input.entry || !(await matches(input.procRoot, input.entry))) return 'pid_changed';
  try {
    input.write(input.pid);
  } catch {
    return 'write_failed';
  }
  try {
    return (await input.confirmMembership()) ? 'migrated' : 'membership_unconfirmed';
  } catch {
    return 'membership_unconfirmed';
  }
}

function removeDirectories(directory: string): void {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    removeDirectories(path.join(directory, entry.name));
  }
  try {
    rmdirSync(directory);
  } catch {
    console.warn('Owned process containment creation cleanup failed');
  }
}

function createManagedCgroup(placement: WorkloadPlacement): Cgroup | undefined {
  const descriptors: number[] = [];
  let created: { directory: string; dev: number; ino: number } | undefined;
  try {
    if (process.platform !== 'linux') return undefined;
    if (statfsSync(placement.parentReference).type !== CGROUP_FS_MAGIC) {
      throw new Error('Workload parent is not a cgroup');
    }
    const parent = fstatSync(placement.parentFd);
    if (parent.dev !== placement.parentDev || parent.ino !== placement.parentIno) {
      throw new Error('Workload parent changed');
    }
    const name = `kilo-control-${crypto.randomUUID()}`;
    try {
      mkdirSync(path.join(placement.parentReference, name));
    } catch (error) {
      if (!isErofs(error)) throw error;
      remountCgroupWritable(placement.parentDirectory);
      mkdirSync(path.join(placement.parentReference, name));
    }
    const directory = path.join(placement.parentDirectory, name);
    const descriptor = openSync(
      path.join(placement.parentReference, name),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    descriptors.push(descriptor);
    const { dev, ino } = fstatSync(descriptor);
    created = { directory, dev, ino };
    const reference = `/proc/self/fd/${descriptor}`;
    if (population(readFileSync(path.join(reference, 'cgroup.events'), 'utf8')) !== 0) {
      throw new Error('Owned process containment is occupied');
    }

    mkdirSync(path.join(reference, WORKLOAD_SERVER_NAME));
    mkdirSync(path.join(reference, WORKLOAD_TOOLS_NAME));
    const serverFd = openSync(
      path.join(reference, WORKLOAD_SERVER_NAME),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    descriptors.push(serverFd);
    const toolsFd = openSync(
      path.join(reference, WORKLOAD_TOOLS_NAME),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    descriptors.push(toolsFd);
    const serverReference = `/proc/self/fd/${serverFd}`;
    const toolsReference = `/proc/self/fd/${toolsFd}`;

    const { cpuController } = applyManagedWorkloadLimits({
      parentReference: reference,
      serverReference,
      toolsReference,
      aggregateMaxBytes: placement.aggregateMaxBytes,
    });

    const procs = openSync(
      path.join(serverReference, 'cgroup.procs'),
      constants.O_WRONLY | constants.O_NOFOLLOW
    );
    descriptors.push(procs);
    const toolsProcs = openSync(
      path.join(toolsReference, 'cgroup.procs'),
      constants.O_WRONLY | constants.O_NOFOLLOW
    );
    descriptors.push(toolsProcs);
    let kill: number | undefined;
    try {
      kill = openSync(
        path.join(reference, 'cgroup.kill'),
        constants.O_WRONLY | constants.O_NOFOLLOW
      );
      descriptors.push(kill);
    } catch {
      console.warn('Owned process cgroup.kill unavailable; using verified child signals');
    }
    return {
      directory,
      reference,
      dev,
      ino,
      descriptors,
      procs,
      procsReference: serverReference,
      managed: { serverReference, toolsReference, toolsProcs, cpuController },
      ...(kill !== undefined ? { kill } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown';
    console.warn(`Owned process workload containment unavailable: ${message}`);
    if (created) {
      try {
        const fresh = lstatSync(created.directory);
        if (fresh.dev === created.dev && fresh.ino === created.ino)
          removeDirectories(created.directory);
      } catch {
        console.warn('Owned process containment creation cleanup failed');
      }
    }
    closeDescriptors(descriptors);
    return undefined;
  }
}

async function assertDirectory(group: Cgroup, deadline: Deadline): Promise<void> {
  if (group.descriptors.length === 0) throw new Error('Owned process containment is closed');
  const value = await deadline.wait(() => lstat(group.directory));
  if (group.descriptors.length === 0 || !value.isDirectory() || !sameDirectory(group, value)) {
    throw new Error('Owned process containment changed');
  }
}

function readText(file: string, deadline: Deadline): Promise<string> {
  return deadline.wait(signal => readFile(file, { encoding: 'utf8', signal }));
}

async function snapshotCgroup(group: Cgroup, deadline: Deadline) {
  await assertDirectory(group, deadline);
  const pids = new Set<number>();
  const directories: { path: string; dev: number; ino: number }[] = [];
  const visit = async (directory: string): Promise<void> => {
    const before = await deadline.wait(() => lstat(directory));
    if (!before.isDirectory() || before.dev !== group.dev) {
      throw new Error('Owned process containment changed');
    }
    for (const pid of parsePids(await readText(path.join(directory, 'cgroup.procs'), deadline))) {
      pids.add(pid);
    }
    const entries = await deadline.wait(() => readdir(directory, { withFileTypes: true }));
    for (const entry of entries) {
      if (entry.isSymbolicLink()) throw new Error('Owned process containment changed');
      if (entry.isDirectory()) await visit(path.join(directory, entry.name));
    }
    const after = await deadline.wait(() => lstat(directory));
    if (before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('Owned process containment changed');
    }
    directories.push({ path: directory, dev: after.dev, ino: after.ino });
  };
  await visit(`${group.reference}/.`);
  await assertDirectory(group, deadline);
  return { pids: [...pids], directories };
}

async function removeCgroupBeforeDeadline(group: Cgroup, deadline: Deadline): Promise<boolean> {
  try {
    const snapshot = await snapshotCgroup(group, deadline);
    if (snapshot.pids.length > 0) return false;
    for (const directory of snapshot.directories) {
      await assertDirectory(group, deadline);
      const fresh = await deadline.wait(() => lstat(directory.path));
      if (fresh.dev !== directory.dev || fresh.ino !== directory.ino) return false;
      deadline.check();
      if (group.descriptors.length === 0) return true;
      rmdirSync(directory.path === `${group.reference}/.` ? group.directory : directory.path);
    }
    closeDescriptors(group.descriptors);
    return true;
  } catch {
    return false;
  }
}

function removeCgroup(group: Cgroup, deadlineAt: number): boolean {
  try {
    const check = (): void => {
      assertBefore(deadlineAt);
      if (!sameDirectory(group, lstatSync(group.directory))) {
        throw new Error('Owned process containment changed');
      }
      assertBefore(deadlineAt);
    };
    check();
    if (population(readFileSync(path.join(group.reference, 'cgroup.events'), 'utf8')) !== 0)
      return false;
    check();
    const removeChildren = (directory: string): void => {
      check();
      const entries = readdirSync(directory, { withFileTypes: true });
      for (const entry of entries) {
        check();
        if (entry.isSymbolicLink()) throw new Error('Owned process containment changed');
        if (!entry.isDirectory()) continue;
        const child = path.join(directory, entry.name);
        const before = lstatSync(child);
        removeChildren(child);
        check();
        const after = lstatSync(child);
        if (before.dev !== after.dev || before.ino !== after.ino) {
          throw new Error('Owned process containment changed');
        }
        check();
        rmdirSync(child);
      }
    };
    removeChildren(group.reference);
    check();
    rmdirSync(group.directory);
    closeDescriptors(group.descriptors);
    return true;
  } catch {
    return false;
  }
}

export function createOwnedProcessScope(placement?: WorkloadPlacement): OwnedProcessScope {
  let group: Cgroup | undefined;
  let activePlacement = placement;
  let attempted = false;
  let contained = true;
  let sealed = false;
  let removed = false;
  let used = false;
  let stopping: Promise<boolean> | undefined;
  let stopResult: boolean | undefined;
  let stopDeadline: Deadline | undefined;
  let stopped = false;
  let abandoned = false;
  let cgroupRemoval: Promise<boolean> | undefined;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let sweeping = false;
  let lastOomKills = 0;
  let lastOomGroupKills = 0;
  const children = new Set<OwnedChild>();
  const baseline = new Set<string>();
  const observations = new Set<Deadline>();
  const workloadReporter = placement?.report ? createWorkloadReporter(placement.report) : undefined;
  const live = (child: OwnedChild): boolean => !child.exited && child.process.pid !== undefined;
  const occupancyGroup = (): Cgroup | undefined =>
    group !== undefined && contained ? group : undefined;
  const occupancyObservable = (): boolean => occupancyGroup() !== undefined;

  const stopSweep = (): void => {
    if (sweepTimer !== undefined) {
      clearInterval(sweepTimer);
      sweepTimer = undefined;
    }
  };

  const sweepManaged = async (): Promise<void> => {
    const managed = group?.managed;
    if (sweeping || !managed || !group || removed || stopped) return;
    sweeping = true;
    const deadline = createDeadline(Date.now() + OBSERVATION_TIMEOUT_MS);
    observations.add(deadline);
    try {
      const root = [...children].find(live)?.process.pid;
      if (root === undefined) return;
      const scopeId = path.basename(group.directory);
      const table = await readProcessTable('/proc');
      const snapshot = await snapshotCgroup(group, deadline);
      const { serverPids, toolPids } = classifyWorkloadMembers(snapshot.pids, table, root);
      const toolsMembers = new Set(
        parsePids(await readText(path.join(managed.toolsReference, 'cgroup.procs'), deadline))
      );
      let migrated = 0;
      for (const pid of toolPids) {
        if (toolsMembers.has(pid)) continue;
        deadline.check();
        const outcome = await migrateWorkloadProcess({
          pid,
          entry: table.get(pid),
          procRoot: '/proc',
          write: value => writeSync(managed.toolsProcs, String(value), 0, 'utf8'),
          confirmMembership: async () => {
            const after = new Set(
              parsePids(await readText(path.join(managed.toolsReference, 'cgroup.procs'), deadline))
            );
            return after.has(pid);
          },
        });
        if (outcome === 'migrated') {
          migrated += 1;
          continue;
        }
        workloadReporter?.emit(scopeId, {
          phase: 'failed',
          workloadPhase: 'migration',
          workloadFailure: outcome,
        });
      }
      if (migrated > 0) {
        workloadReporter?.emit(scopeId, {
          phase: 'completed',
          workloadPhase: 'migration',
          migratedCount: migrated,
        });
      }
      const stats = readWorkloadStats(group.reference);
      if (stats.oomKills > lastOomKills || stats.oomGroupKills > lastOomGroupKills) {
        lastOomKills = Math.max(lastOomKills, stats.oomKills);
        lastOomGroupKills = Math.max(lastOomGroupKills, stats.oomGroupKills);
        workloadReporter?.emit(scopeId, {
          phase: 'failed',
          workloadPhase: 'oom',
          oomKills: stats.oomKills,
          oomGroupKills: stats.oomGroupKills,
        });
      }
      workloadReporter?.emit(scopeId, {
        phase: 'completed',
        workloadPhase: 'stats',
        toolCount: toolPids.length,
        serverCount: serverPids.length,
        migratedCount: migrated,
        oomKills: stats.oomKills,
        oomGroupKills: stats.oomGroupKills,
        cpuController: managed.cpuController,
        ...(stats.currentBytes !== undefined ? { currentBytes: stats.currentBytes } : {}),
        ...(stats.peakBytes !== undefined ? { peakBytes: stats.peakBytes } : {}),
        ...(stats.pressureSomeTotal !== undefined
          ? { pressureSomeTotal: stats.pressureSomeTotal }
          : {}),
        ...(stats.pressureFullTotal !== undefined
          ? { pressureFullTotal: stats.pressureFullTotal }
          : {}),
      });
    } catch {
      workloadReporter?.emit(path.basename(group.directory), {
        phase: 'failed',
        workloadPhase: 'migration',
        workloadFailure: 'unavailable',
      });
    } finally {
      sweeping = false;
      observations.delete(deadline);
      deadline.close();
    }
  };

  const startSweep = (): void => {
    if (sweepTimer !== undefined || !activePlacement) return;
    sweepTimer = setInterval(() => void sweepManaged(), WORKLOAD_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  };

  const verify = async (allowBaseline: boolean, deadline: Deadline): Promise<boolean> => {
    try {
      deadline.check();
      if (!used || removed || stopped) return true;
      const observed = occupancyGroup();
      if (!observed) return false;
      await assertDirectory(observed, deadline);
      const populated = population(
        await readText(path.join(observed.reference, 'cgroup.events'), deadline)
      );
      await assertDirectory(observed, deadline);
      if (populated === 0) return ![...children].some(live);
      if (!allowBaseline || baseline.size === 0) {
        if (allowBaseline || [...children].some(live)) return false;
        for (const pid of (await snapshotCgroup(observed, deadline)).pids) {
          const { state } = processIdentity(pid, await readText(`/proc/${pid}/stat`, deadline));
          if (isLiveProcessState(state)) return false;
        }
        return true;
      }
      const identities = new Set<string>();
      for (const pid of (await snapshotCgroup(observed, deadline)).pids) {
        const { identity } = processIdentity(pid, await readText(`/proc/${pid}/stat`, deadline));
        if (!baseline.has(identity)) return false;
        identities.add(identity);
      }
      await assertDirectory(observed, deadline);
      return (
        identities.size > 0 &&
        [...children]
          .filter(live)
          .every(child => child.identity !== undefined && identities.has(child.identity))
      );
    } catch {
      return false;
    }
  };

  const signalChildren = async (signal: NodeJS.Signals, deadline: Deadline): Promise<void> => {
    for (const child of children) {
      deadline.check();
      const pid = child.process.pid;
      if (!live(child) || pid === undefined) continue;
      try {
        if (process.platform === 'linux') {
          const fresh = processIdentity(pid, await readText(`/proc/${pid}/stat`, deadline));
          if (!child.identity || fresh.identity !== child.identity || fresh.parent !== process.pid)
            continue;
          deadline.check();
          if (!live(child)) continue;
          if (fresh.group === pid) {
            process.kill(-pid, signal);
            continue;
          }
        }
        deadline.check();
        if (live(child)) child.process.kill(signal);
      } catch {
        console.warn('Owned process child signal failed; cleanup still requires verification');
      }
    }
  };

  const scope: OwnedProcessScope = {
    spawn(command, args, options) {
      if (sealed) throw new Error('Owned process admission is closed');
      if (activePlacement && options.shell !== undefined && options.shell !== false) {
        throw new Error('Owned process placement rejects shell spawn');
      }
      if (!attempted) {
        attempted = true;
        group = activePlacement ? createManagedCgroup(activePlacement) : createCgroup();
      }
      if (activePlacement && !group) {
        workloadReporter?.emit(undefined, {
          phase: 'failed',
          workloadPhase: 'failed',
          workloadFailure: 'unavailable',
        });
        activePlacement = undefined;
      }
      const gated =
        group !== undefined && options.shell !== true && typeof options.shell !== 'string';

      const spawnChild = (gatedChild: boolean): OwnedChild => {
        const child = gatedChild
          ? spawn(
              '/bin/sh',
              [
                '-c',
                'IFS= read -r start <&3 && [ "$start" = start ] && exec 3<&- && exec "$@"',
                'kilo-owned',
                command,
                ...args,
              ],
              { ...options, detached: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] }
            )
          : spawn(command, args, { ...options, detached: true, stdio: 'pipe' });
        const record: OwnedChild = { process: child, exited: false };
        children.add(record);
        child.once('exit', () => {
          record.exited = true;
        });
        child.once('error', () => {
          if (child.pid === undefined) record.exited = true;
        });
        if (child.pid !== undefined) {
          used = true;
          try {
            const fresh = processIdentity(
              child.pid,
              readFileSync(`/proc/${child.pid}/stat`, 'utf8')
            );
            if (fresh.parent === process.pid) record.identity = fresh.identity;
          } catch {
            console.warn('Owned process child identity unavailable; group signals remain disabled');
          }
          if (!gatedChild) contained = false;
        }
        return record;
      };

      const record = spawnChild(gated);
      if (!gated) {
        startSweep();
        return record.process;
      }
      const gate = record.process.stdio[3];
      if (gate instanceof Writable) record.gate = gate;
      try {
        const pid = record.process.pid;
        if (
          !(gate instanceof Writable) ||
          !group ||
          pid === undefined ||
          !record.identity ||
          !sameDirectory(group, lstatSync(group.directory))
        ) {
          throw new Error('Owned child identity unavailable');
        }
        const fresh = processIdentity(pid, readFileSync(`/proc/${pid}/stat`, 'utf8'));
        if (fresh.identity !== record.identity || fresh.parent !== process.pid) {
          throw new Error('Owned child changed');
        }
        writeSync(group.procs, String(pid), 0, 'utf8');
        if (
          !sameDirectory(group, lstatSync(group.directory)) ||
          !parsePids(
            readFileSync(path.join(group.procsReference, 'cgroup.procs'), 'utf8')
          ).includes(pid)
        ) {
          throw new Error('Owned child containment unavailable');
        }
        const activated = processIdentity(pid, readFileSync(`/proc/${pid}/stat`, 'utf8'));
        if (activated.identity !== record.identity || activated.parent !== process.pid) {
          throw new Error('Owned child changed');
        }
        releaseGate(gate);
      } catch {
        contained = false;
        if (gate instanceof Writable) {
          gate.on('error', () => undefined);
          gate.end();
        }
        activePlacement = undefined;
        workloadReporter?.emit(group ? path.basename(group.directory) : undefined, {
          phase: 'failed',
          workloadPhase: 'failed',
          workloadFailure: 'unavailable',
        });
        try {
          record.process.kill('SIGKILL');
        } catch {
          console.warn('Owned process gated child kill failed; continuing unmanaged');
        }
        return spawnChild(false).process;
      }
      startSweep();
      return record.process;
    },
    observeChild(child) {
      const record = [...children].find(candidate => candidate.process === child);
      if (!record) return undefined;
      return {
        observe(deadlineAt = Date.now() + OBSERVATION_TIMEOUT_MS) {
          const deadline = createDeadline(deadlineAt);
          observations.add(deadline);
          return (async (): Promise<DirectProcessState> => {
            if (record.exited || record.process.pid === undefined) return 'absent';
            const pid = record.process.pid;
            if (process.platform !== 'linux') {
              try {
                process.kill(pid, 0);
                return classifyDirectProcessState({
                  exited: false,
                  pid,
                  platform: process.platform,
                  storedIdentity: record.identity,
                });
              } catch (error) {
                return classifyDirectProcessState({
                  exited: false,
                  pid,
                  platform: process.platform,
                  storedIdentity: record.identity,
                  probeError: error as NodeJS.ErrnoException,
                });
              }
            }
            try {
              const text = await readText(`/proc/${pid}/stat`, deadline);
              return classifyDirectProcessState({
                exited: false,
                pid,
                platform: process.platform,
                storedIdentity: record.identity,
                statText: text,
              });
            } catch (error) {
              return classifyDirectProcessState({
                exited: false,
                pid,
                platform: process.platform,
                storedIdentity: record.identity,
                probeError: error as NodeJS.ErrnoException,
              });
            }
          })().finally(() => {
            observations.delete(deadline);
            deadline.close();
          });
        },
      };
    },
    // Call only after stop() has settled; it releases streams for an unproven scope.
    releaseAbandoned() {
      if (stopped || removed || abandoned) return;
      abandoned = true;
      stopSweep();
      for (const child of children) releaseChildStreams(child);
      if (group) closeDescriptors(group.descriptors);
    },
    run: operation => current.run(scope, operation),
    observesOccupancy: occupancyObservable,
    seal() {
      sealed = true;
    },
    dispose() {
      sealed = true;
      stopSweep();
      if (removed) return true;
      if (stopped) return true;
      if (abandoned) return false;
      if (used && (!occupancyObservable() || [...children].some(live))) return false;
      if (
        group &&
        !removeCgroup(group, stopDeadline?.deadlineAt ?? Date.now() + OBSERVATION_TIMEOUT_MS)
      )
        return false;
      removed = true;
      children.clear();
      return true;
    },
    async captureBaseline(allowed, deadlineAt = Date.now() + OBSERVATION_TIMEOUT_MS) {
      baseline.clear();
      const deadline = createDeadline(Math.min(deadlineAt, stopDeadline?.deadlineAt ?? Infinity));
      observations.add(deadline);
      try {
        const observed = occupancyGroup();
        if (!observed || sealed) return;
        const entries: (ProcessIdentity & { allowed: boolean })[] = [];
        for (const pid of (await snapshotCgroup(observed, deadline)).pids) {
          const before = processIdentity(pid, await readText(`/proc/${pid}/stat`, deadline));
          const argv = (await readText(`/proc/${pid}/cmdline`, deadline))
            .split('\0')
            .filter(Boolean);
          const after = processIdentity(pid, await readText(`/proc/${pid}/stat`, deadline));
          if (before.identity !== after.identity || before.parent !== after.parent) {
            throw new Error('Native process identity changed');
          }
          entries.push({ ...after, allowed: allowed(argv) });
        }
        const roots = [...children].filter(live);
        const root = roots[0];
        if (roots.length !== 1 || !root) {
          throw new Error('Native process ownership is ambiguous');
        }
        if (entries.find(entry => entry.pid === root.process.pid)?.identity !== root.identity) {
          contained = false;
          throw new Error('Native process containment changed');
        }
        let pid = root.process.pid;
        const captured = new Set<string>();
        while (pid !== undefined) {
          const entry = entries.find(entry => entry.pid === pid);
          if (!entry?.allowed || captured.has(entry.identity)) {
            throw new Error('Native process identity unavailable');
          }
          captured.add(entry.identity);
          const descendants = entries.filter(
            candidate => candidate.parent === pid && candidate.allowed
          );
          if (descendants.length > 1) throw new Error('Native process ownership is ambiguous');
          pid = descendants[0]?.pid;
        }
        deadline.check();
        if (!sealed) {
          for (const identity of captured) baseline.add(identity);
        }
      } catch {
        baseline.clear();
      } finally {
        observations.delete(deadline);
        deadline.close();
      }
    },
    async verify(allowBaseline = false, deadlineAt = Date.now() + OBSERVATION_TIMEOUT_MS) {
      if (stopped || removed || !used) return true;
      if (stopping && stopResult !== false) return false;
      const deadline = createDeadline(deadlineAt);
      observations.add(deadline);
      try {
        return await verify(allowBaseline, deadline);
      } catch {
        return false;
      } finally {
        observations.delete(deadline);
        deadline.close();
      }
    },
    stop(deadlineAt) {
      sealed = true;
      stopSweep();
      for (const observation of observations) observation.shorten(deadlineAt);
      if (stopping) {
        if (!stopped) stopDeadline?.shorten(deadlineAt);
        return stopping;
      }
      const deadline = createDeadline(deadlineAt);
      stopDeadline = deadline;
      let deathProven = false;
      const run = async (): Promise<boolean> => {
        if (await verify(false, deadline)) {
          deathProven = true;
          return true;
        }
        await signalChildren('SIGTERM', deadline);
        if ([...children].some(live)) {
          const graceMs = Math.min(250, Math.max(0, (deadline.deadlineAt - Date.now()) / 2));
          await deadline.wait(signal => delay(graceMs, undefined, { signal }));
        }
        if (group?.kill !== undefined) {
          try {
            await assertDirectory(group, deadline);
            deadline.check();
            if (!removed && group.descriptors.includes(group.kill)) {
              writeSync(group.kill, '1', 0, 'utf8');
            }
          } catch {
            console.warn('Owned process cgroup kill failed; using verified child signals');
          }
        }
        await signalChildren('SIGKILL', deadline);
        if (!occupancyObservable()) return false;
        while (true) {
          if (await verify(false, deadline)) {
            deathProven = true;
            return true;
          }
          await deadline.wait(signal => delay(25, undefined, { signal }));
        }
      };
      const removeCgroupAfterDeath = (): void => {
        if (!group || removed || cgroupRemoval) return;
        const removalDeadline = createDeadline(deadline.deadlineAt);
        cgroupRemoval = removeCgroupBeforeDeadline(group, removalDeadline)
          .catch(() => false)
          .then(result => {
            if (result) removed = true;
            return result;
          })
          .finally(() => removalDeadline.close());
      };
      stopping = deadline
        .wait(run)
        .catch(() => deathProven)
        .then(result => {
          if (!result) return false;
          stopped = true;
          children.clear();
          removeCgroupAfterDeath();
          return true;
        })
        .catch(() => false)
        .then(result => {
          stopResult = result;
          return result;
        })
        .finally(() => deadline.close());
      return stopping;
    },
  };
  return scope;
}

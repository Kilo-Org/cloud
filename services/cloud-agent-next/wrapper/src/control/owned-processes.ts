import { AsyncLocalStorage } from 'node:async_hooks';
import {
  spawn,
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

export type OwnedProcessScope = {
  spawn(
    command: string,
    args: string[],
    options: SpawnOptionsWithoutStdio
  ): ChildProcessWithoutNullStreams;
  run<T>(operation: () => T): T;
  seal(): void;
  dispose(): boolean;
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
};
type Cgroup = {
  directory: string;
  reference: string;
  dev: number;
  ino: number;
  descriptors: number[];
  procs: number;
  kill?: number;
};

const OBSERVATION_TIMEOUT_MS = 1_000;
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

function closeDescriptors(descriptors: number[]): void {
  for (const descriptor of descriptors.splice(0)) {
    try {
      closeSync(descriptor);
    } catch {
      console.warn('Owned process descriptor close failed; continuing descriptor cleanup');
    }
  }
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
    descriptors.push(
      openSync(
        path.join(parentReference, 'cgroup.procs'),
        constants.O_WRONLY | constants.O_NOFOLLOW
      )
    );
    const name = `kilo-control-${crypto.randomUUID()}`;
    mkdirSync(path.join(parentReference, name));
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
    return { directory, reference, dev, ino, descriptors, procs, kill };
  } catch {
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

export function createOwnedProcessScope(): OwnedProcessScope {
  let group: Cgroup | undefined;
  let attempted = false;
  let contained = true;
  let sealed = false;
  let removed = false;
  let used = false;
  let stopping: Promise<boolean> | undefined;
  let stopDeadline: Deadline | undefined;
  let stopped = false;
  const children = new Set<OwnedChild>();
  const baseline = new Set<string>();
  const observations = new Set<Deadline>();
  const live = (child: OwnedChild): boolean => !child.exited && child.process.pid !== undefined;

  const verify = async (allowBaseline: boolean, deadline: Deadline): Promise<boolean> => {
    try {
      deadline.check();
      if (!used || removed || stopped) return true;
      if (!group || !contained) return false;
      await assertDirectory(group, deadline);
      const populated = population(
        await readText(path.join(group.reference, 'cgroup.events'), deadline)
      );
      await assertDirectory(group, deadline);
      if (populated === 0) return ![...children].some(live);
      if (!allowBaseline || baseline.size === 0) {
        if (allowBaseline || [...children].some(live)) return false;
        for (const pid of (await snapshotCgroup(group, deadline)).pids) {
          const { state } = processIdentity(pid, await readText(`/proc/${pid}/stat`, deadline));
          if (isLiveProcessState(state)) return false;
        }
        return true;
      }
      const identities = new Set<string>();
      for (const pid of (await snapshotCgroup(group, deadline)).pids) {
        const { identity } = processIdentity(pid, await readText(`/proc/${pid}/stat`, deadline));
        if (!baseline.has(identity)) return false;
        identities.add(identity);
      }
      await assertDirectory(group, deadline);
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
      if (!attempted) {
        attempted = true;
        group = createCgroup();
      }
      const gated =
        group !== undefined && options.shell !== true && typeof options.shell !== 'string';
      const child = gated
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
          const fresh = processIdentity(child.pid, readFileSync(`/proc/${child.pid}/stat`, 'utf8'));
          if (fresh.parent === process.pid) record.identity = fresh.identity;
        } catch {
          console.warn('Owned process child identity unavailable; group signals remain disabled');
        }
        if (!gated) contained = false;
      }
      if (gated) {
        const gate = child.stdio[3];
        try {
          if (
            !(gate instanceof Writable) ||
            !group ||
            child.pid === undefined ||
            !record.identity ||
            !sameDirectory(group, lstatSync(group.directory))
          ) {
            throw new Error('Owned child identity unavailable');
          }
          const fresh = processIdentity(child.pid, readFileSync(`/proc/${child.pid}/stat`, 'utf8'));
          if (fresh.identity !== record.identity || fresh.parent !== process.pid) {
            throw new Error('Owned child changed');
          }
          writeSync(group.procs, String(child.pid), 0, 'utf8');
          if (
            !sameDirectory(group, lstatSync(group.directory)) ||
            !parsePids(readFileSync(path.join(group.reference, 'cgroup.procs'), 'utf8')).includes(
              child.pid
            )
          ) {
            throw new Error('Owned child containment unavailable');
          }
          const activated = processIdentity(
            child.pid,
            readFileSync(`/proc/${child.pid}/stat`, 'utf8')
          );
          if (activated.identity !== record.identity || activated.parent !== process.pid) {
            throw new Error('Owned child changed');
          }
          gate.on('error', () => {
            contained = false;
          });
          gate.end('start\n');
        } catch {
          contained = false;
          sealed = true;
          if (gate instanceof Writable) {
            gate.on('error', () => undefined);
            gate.end();
          }
        }
      }
      return child;
    },
    run: operation => current.run(scope, operation),
    seal() {
      sealed = true;
    },
    dispose() {
      sealed = true;
      if (removed) return true;
      if (used && (!group || !contained || [...children].some(live))) return false;
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
        if (!group || !contained || sealed) return;
        const entries: (ProcessIdentity & { allowed: boolean })[] = [];
        for (const pid of (await snapshotCgroup(group, deadline)).pids) {
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
      if (stopping) return false;
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
      for (const observation of observations) observation.shorten(deadlineAt);
      if (stopping) {
        if (!stopped) stopDeadline?.shorten(deadlineAt);
        return stopping;
      }
      const deadline = createDeadline(deadlineAt);
      stopDeadline = deadline;
      const run = async (): Promise<boolean> => {
        if (await verify(false, deadline)) return true;
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
        if (!group || !contained) return false;
        while (true) {
          if (await verify(false, deadline)) return true;
          await deadline.wait(signal => delay(25, undefined, { signal }));
        }
      };
      stopping = deadline
        .wait(async () => {
          if (!(await run())) return false;
          deadline.check();
          if (!group || removed || (await removeCgroupBeforeDeadline(group, deadline))) {
            removed = true;
            children.clear();
          }
          deadline.check();
          stopped = true;
          return true;
        })
        .catch(() => false)
        .finally(() => deadline.close());
      return stopping;
    },
  };
  return scope;
}

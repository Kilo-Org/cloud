import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import type { ProcessSpawn } from '../utils.js';
import { releaseGate, spawnGated } from './gated-spawn.js';
import {
  admitControlWorkload,
  type ControlWorkload,
  type WorkloadPlacement,
} from './workload-cgroup.js';

export const WORKLOAD_SETUP_NAME = 'kilo-setup';

export type SetupCgroup = { procs: number; procsPath: string };

/**
 * Setup commands run in one leaf under the workload parent, so setup, Kilo and tools together stay
 * within the parent's cap and the wrapper keeps its reserve for the connection. The leaf outlives
 * each command: daemons a setup command starts keep running, and counting, there.
 */
export function createSetupSpawn(workload: ControlWorkload): ProcessSpawn {
  let leaf: SetupCgroup | undefined;
  return (command, args, options) => {
    if (!leaf) {
      const placement = admitControlWorkload(workload);
      if (!placement) return spawn(command, args, options);
      leaf = openSetupCgroup(placement);
      if (!leaf) {
        console.warn('Setup command cgroup unavailable; running unmanaged');
        return spawn(command, args, options);
      }
    }
    return spawnInCgroup(leaf, command, args, options);
  };
}

function openSetupCgroup(placement: WorkloadPlacement): SetupCgroup | undefined {
  let descriptor: number | undefined;
  try {
    const directory = path.join(placement.parentReference, WORKLOAD_SETUP_NAME);
    try {
      mkdirSync(directory);
    } catch (error) {
      // A restarted wrapper reuses the leaf its predecessor created.
      if (!isEexist(error)) throw error;
    }
    descriptor = openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    );
    const reference = `/proc/self/fd/${descriptor}`;
    applySetupLimits(reference);
    const procsPath = path.join(reference, 'cgroup.procs');
    return { procs: openSync(procsPath, constants.O_WRONLY | constants.O_NOFOLLOW), procsPath };
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    return undefined;
  }
}

export function applySetupLimits(reference: string): void {
  // 0: an OOM kills the largest setup process, not the daemons earlier setup commands started.
  writeFileSync(path.join(reference, 'memory.oom.group'), '0');
  try {
    writeFileSync(path.join(reference, 'memory.swap.max'), '0');
  } catch {
    // Swap accounting is optional.
  }
}

/** Moves the gated child into the leaf before it execs; any failure falls back to a plain spawn. */
export function spawnInCgroup(
  leaf: SetupCgroup,
  command: string,
  args: string[],
  options: SpawnOptions
): ChildProcess {
  const stdio = Array.isArray(options.stdio)
    ? options.stdio.slice(0, 3)
    : (['ignore', 'pipe', 'pipe'] as const);
  const child = spawnGated(command, args, { ...options, stdio: [...stdio, 'pipe'] });
  const gate = child.stdio[3];
  try {
    const pid = child.pid;
    if (pid === undefined || !(gate instanceof Writable)) {
      throw new Error('Setup command gate unavailable');
    }
    writeSync(leaf.procs, String(pid), 0, 'utf8');
    if (!readFileSync(leaf.procsPath, 'utf8').split('\n').includes(String(pid))) {
      throw new Error('Setup command placement unconfirmed');
    }
    releaseGate(gate);
    return child;
  } catch {
    child.on('error', () => undefined);
    if (gate instanceof Writable) {
      gate.on('error', () => undefined);
      gate.end();
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.kill('SIGKILL');
    console.warn('Setup command cgroup placement failed; running unmanaged');
    return spawn(command, args, options);
  }
}

function isEexist(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

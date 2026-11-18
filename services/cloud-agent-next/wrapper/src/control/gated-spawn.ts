import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import type { Writable } from 'node:stream';

const GATE_SCRIPT = 'IFS= read -r start && [ "$start" = start ] && exec "$@"';

/**
 * Starts `command` behind a shell that waits for `start` on stdin, so the caller can move the
 * child into a cgroup before it execs or forks. `options.stdio` must make stdin a pipe; the
 * command keeps it as its stdin. The gate is not an extra pipe: Bun 1.3 closes the parent end of
 * a pipe at fd 3 or above again when it collects the subprocess, which closes whatever
 * descriptor has reused that number by then (fixed in Bun 1.4, oven-sh/bun#33828).
 */
export function spawnGated(
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
): ChildProcessWithoutNullStreams;
export function spawnGated(command: string, args: string[], options: SpawnOptions): ChildProcess;
export function spawnGated(command: string, args: string[], options: SpawnOptions): ChildProcess {
  return spawn('/bin/sh', ['-c', GATE_SCRIPT, 'kilo-owned', command, ...args], options);
}

/** Opens the gate. The pipe stays open as the command's stdin. */
export function releaseGate(gate: Writable): void {
  gate.on('error', () => undefined);
  gate.write('start\n');
}

import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import type { Writable } from 'node:stream';

const GATE_SCRIPT = 'IFS= read -r start <&3 && [ "$start" = start ] && exec 3<&- && exec "$@"';

/**
 * Starts `command` behind a shell that waits for `start` on fd 3, so the caller can move the
 * child into a cgroup before it execs or forks. `options.stdio` must make fd 3 a pipe.
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

export function releaseGate(gate: Writable): void {
  gate.on('error', () => undefined);
  gate.end('start\n');
}

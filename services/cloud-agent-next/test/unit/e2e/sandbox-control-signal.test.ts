/**
 * `signalKiloServerProcess` maps the harness signal names to a real
 * `kill -<SIGNAL>` for the exact captured process. `KILL` is the new-plane
 * Kilo/wrapper kill fault; `STOP`/`CONT` remain the freeze/resume fault.
 *
 * `isControlWrapperArgv` is the single argv matcher behind both the legacy and
 * new-plane wrapper captures; it is embedded in the container discovery script,
 * so it is tested directly with representative Bun argv shapes.
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CONTROL_PLANE_WRAPPER_BASENAME,
  isControlWrapperArgv,
  isLiveProcessState,
  LEGACY_CONTROL_WRAPPER_BASENAME,
  processStateFromStat,
  signalKiloServerProcess,
  type DockerCommandExecutor,
} from '../../e2e/sandbox-control.js';

function recordingExecutor(): { calls: string[][]; execute: DockerCommandExecutor } {
  const calls: string[][] = [];
  return {
    calls,
    execute: async args => {
      calls.push(args);
      return { stdout: '' };
    },
  };
}

describe('signalKiloServerProcess', () => {
  it.each(['STOP', 'CONT', 'KILL'] as const)(
    'sends kill -%s to the exact captured pid',
    async signal => {
      const { calls, execute } = recordingExecutor();
      await signalKiloServerProcess(
        { containerId: 'container-1', processId: 4242 },
        signal,
        execute
      );
      expect(calls).toEqual([['exec', 'container-1', 'kill', `-${signal}`, '4242']]);
    }
  );
});

describe('isControlWrapperArgv', () => {
  const basenameOf = (value: string) => path.basename(value);
  const legacyArgv = ['bun', 'run', `/usr/local/bin/${LEGACY_CONTROL_WRAPPER_BASENAME}`];
  const controlPlaneargv = ['bun', 'run', `/usr/local/bin/${CONTROL_PLANE_WRAPPER_BASENAME}`];

  it('matches the legacy wrapper only under the legacy basename', () => {
    expect(isControlWrapperArgv(legacyArgv, basenameOf, LEGACY_CONTROL_WRAPPER_BASENAME)).toBe(
      true
    );
    expect(isControlWrapperArgv(legacyArgv, basenameOf, CONTROL_PLANE_WRAPPER_BASENAME)).toBe(
      false
    );
  });

  it('matches the new-plane wrapper only under the control-plane basename', () => {
    expect(
      isControlWrapperArgv(controlPlaneargv, basenameOf, CONTROL_PLANE_WRAPPER_BASENAME)
    ).toBe(true);
    expect(isControlWrapperArgv(controlPlaneargv, basenameOf, LEGACY_CONTROL_WRAPPER_BASENAME)).toBe(
      false
    );
  });

  it('requires a Bun argv element', () => {
    const withoutBun = ['node', `/usr/local/bin/${LEGACY_CONTROL_WRAPPER_BASENAME}`];
    expect(isControlWrapperArgv(withoutBun, basenameOf, LEGACY_CONTROL_WRAPPER_BASENAME)).toBe(
      false
    );
  });

  it('does not match the Kilo server or the supervisor', () => {
    expect(isControlWrapperArgv(['kilo', 'serve'], basenameOf, LEGACY_CONTROL_WRAPPER_BASENAME)).toBe(
      false
    );
    expect(
      isControlWrapperArgv(
        ['sh', '/usr/local/bin/kilocode-control-plane-supervisor.sh'],
        basenameOf,
        CONTROL_PLANE_WRAPPER_BASENAME
      )
    ).toBe(false);
  });
});

describe('process liveness from /proc/<pid>/stat', () => {
  it('reads the state after the last closing paren of the comm field', () => {
    // comm contains spaces and a ')' — the naive first split would be wrong.
    expect(processStateFromStat('123 (my proc) name) R 1 2 3')).toBe('R');
    expect(processStateFromStat('123 (bun) S 1 2')).toBe('S');
    expect(processStateFromStat('unparseable')).toBeNull();
  });

  it('treats zombie, dead and absent processes as not live', () => {
    expect(isLiveProcessState('R')).toBe(true);
    expect(isLiveProcessState('S')).toBe(true);
    expect(isLiveProcessState('Z')).toBe(false);
    expect(isLiveProcessState('X')).toBe(false);
    expect(isLiveProcessState(null)).toBe(false);
  });
});

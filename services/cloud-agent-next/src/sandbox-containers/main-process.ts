import { CONTROL_SUPERVISOR_PATH } from '../sandbox-control/container-paths.js';
import { diagnosticCause, type ControlDiagnosticFields } from '../sandbox-control/diagnostics.js';

export type MainProcessIdentity = 'sleep' | 'supervisor' | 'ambiguous';

/**
 * One read of `/proc/1/cmdline` and the identity it decided. Everything except a
 * recognised cmdline is `ambiguous`; the kind keeps why, for diagnostics only.
 * `deadline` is a read cut off by the caller's deadline, so it saw nothing.
 */
export type MainProcessObservation =
  | { kind: 'cmdline'; identity: MainProcessIdentity; cmdline: Uint8Array }
  | { kind: 'exit_code'; identity: 'ambiguous'; exitCode: number }
  | { kind: 'deadline'; identity: 'ambiguous' }
  | { kind: 'error'; identity: 'ambiguous'; error: unknown };

const MAIN_PROCESS_SLEEP_CMDLINE = new TextEncoder().encode('sleep\0infinity');
const MAIN_PROCESS_SUPERVISOR_CMDLINE = new TextEncoder().encode(
  `/bin/sh\0${CONTROL_SUPERVISOR_PATH}`
);

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function withoutTrailingNul(cmdline: Uint8Array): Uint8Array {
  return cmdline.byteLength > 0 && cmdline[cmdline.byteLength - 1] === 0
    ? cmdline.subarray(0, cmdline.byteLength - 1)
    : cmdline;
}

/**
 * Classify PID 1 from its `/proc/1/cmdline` bytes. The two known main processes
 * are the image default `sleep infinity` and the native supervisor entrypoint;
 * a trailing NUL is tolerated. Timeout, non-zero, empty, and anything else is
 * ambiguous and must fail the launch rather than guess.
 */
export function classifyMainProcess(cmdline: Uint8Array): MainProcessIdentity {
  const trimmed = withoutTrailingNul(cmdline);
  if (bytesEqual(trimmed, MAIN_PROCESS_SLEEP_CMDLINE)) return 'sleep';
  if (bytesEqual(trimmed, MAIN_PROCESS_SUPERVISOR_CMDLINE)) return 'supervisor';
  return 'ambiguous';
}

export function observeCmdline(cmdline: Uint8Array): MainProcessObservation {
  return { kind: 'cmdline', identity: classifyMainProcess(cmdline), cmdline };
}

/**
 * Diagnostic fields for the last observation a check completed, or `none` when
 * every read was cut off. The cmdline is PID 1's argv, which this DO chose as the
 * entrypoint; it is joined with spaces and bounded by `diagnosticCause`.
 */
export function mainProcessObservationFields(
  observation: MainProcessObservation | null
): ControlDiagnosticFields {
  if (observation === null) return { lastSeen: 'none' };
  const fields: ControlDiagnosticFields = {
    lastSeen: observation.kind,
    lastIdentity: observation.identity,
  };
  switch (observation.kind) {
    case 'cmdline': {
      const argv = new TextDecoder().decode(withoutTrailingNul(observation.cmdline)).split('\0');
      const cmdline = argv.join(' ');
      return {
        ...fields,
        lastCmdline: cmdline === '' ? 'empty' : diagnosticCause(cmdline),
        lastCmdlineBytes: observation.cmdline.byteLength,
      };
    }
    case 'exit_code':
      return { ...fields, lastExitCode: observation.exitCode };
    case 'error':
      return {
        ...fields,
        lastErrorName:
          observation.error instanceof Error ? diagnosticCause(observation.error.name) : 'unknown',
        lastCause:
          observation.error instanceof Error
            ? diagnosticCause(observation.error.message)
            : 'unknown',
      };
    case 'deadline':
      return fields;
  }
}

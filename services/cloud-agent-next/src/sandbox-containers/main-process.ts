import { CONTROL_SUPERVISOR_PATH } from '../sandbox-control/container-paths.js';
import { diagnosticCause, type ControlDiagnosticFields } from '../sandbox-control/diagnostics.js';
import type { ProviderStartupCommand } from '../sandbox-control/provider.js';

export type MainProcessIdentity = 'sleep' | 'supervisor' | 'startup' | 'ambiguous';

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
 * Classify PID 1 from its exact argv bytes, allowing a trailing NUL. The supplied
 * startup command and stable supervisor confirm issuance. The image default
 * `sleep infinity` leaves the existing exec path available.
 */
export function classifyMainProcess(
  cmdline: Uint8Array,
  command?: ProviderStartupCommand
): MainProcessIdentity {
  const trimmed = withoutTrailingNul(cmdline);
  if (bytesEqual(trimmed, MAIN_PROCESS_SUPERVISOR_CMDLINE)) return 'supervisor';
  if (command && bytesEqual(trimmed, new TextEncoder().encode(command.argv.join('\0'))))
    return 'startup';
  if (bytesEqual(trimmed, MAIN_PROCESS_SLEEP_CMDLINE)) return 'sleep';
  return 'ambiguous';
}

export function observeCmdline(
  cmdline: Uint8Array,
  command?: ProviderStartupCommand
): MainProcessObservation {
  return { kind: 'cmdline', identity: classifyMainProcess(cmdline, command), cmdline };
}

/**
 * Diagnostic fields for the last observation a check completed, or `none` when
 * every read was cut off. Only fixed known commands can be logged. Startup and
 * unknown argv can contain a short-lived artifact grant.
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
      const cmdline =
        observation.identity === 'supervisor' || observation.identity === 'sleep'
          ? argv.join(' ')
          : observation.cmdline.byteLength === 0
            ? 'empty'
            : 'redacted';
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

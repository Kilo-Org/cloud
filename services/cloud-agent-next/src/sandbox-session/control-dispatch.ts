import type { ConnectionState, PhysicalState } from '../sandbox-control/status-projection.js';

export type ControlDispatchDisposition = 'send' | 'wait' | 'fail';

export type QueueFailureReason =
  | 'environment_failed'
  | 'provider_unknown'
  | 'attach_exhausted'
  | 'prompt_exhausted'
  | 'accepted_overdue'
  | 'missing_metadata';

export function controlDispatchDisposition(status: {
  connection: ConnectionState;
  physical: PhysicalState;
}): ControlDispatchDisposition {
  if (
    status.physical === 'failed' ||
    status.physical === 'unknown' ||
    status.physical === 'stopped'
  ) {
    return 'fail';
  }
  if (status.connection === 'ready') return 'send';
  return 'wait';
}

export function failureReasonFromControlStatus(
  physical: PhysicalState
): QueueFailureReason | undefined {
  if (physical === 'unknown') return 'provider_unknown';
  if (physical === 'failed' || physical === 'stopped' || physical === 'stopping') {
    return 'environment_failed';
  }
  return undefined;
}

export function safeErrorFromQueueReason(reason: string): string {
  switch (reason) {
    case 'missing_metadata':
      return 'Session is missing required metadata';
    case 'provider_unknown':
      return 'Environment state is unknown';
    case 'attach_exhausted':
      return 'Environment preparation failed';
    case 'prompt_exhausted':
      return 'Prompt delivery failed';
    case 'accepted_overdue':
      return 'Turn did not complete';
    default:
      return 'Environment failed';
  }
}

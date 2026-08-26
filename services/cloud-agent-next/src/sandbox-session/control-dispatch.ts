import type { ConnectionState, PhysicalState } from '../sandbox-control/status-projection.js';

export type ControlDispatchDisposition = 'send' | 'wait' | 'fail';

type ControlStatus = {
  connection: ConnectionState;
  physical: PhysicalState;
};

export type QueueFailureReason =
  | 'environment_failed'
  | 'provider_unknown'
  | 'attach_exhausted'
  | 'prompt_exhausted'
  | 'accepted_overdue'
  | 'missing_metadata';

export function controlDispatchDisposition(status: ControlStatus): ControlDispatchDisposition {
  if (
    status.physical === 'failed' ||
    status.physical === 'unknown' ||
    status.physical === 'stopped'
  ) {
    return 'fail';
  }
  if (status.physical === 'stopping') return 'wait';
  if (status.connection === 'ready') return 'send';
  return 'wait';
}

export async function observeControlAfterStopping(
  status: ControlStatus,
  getStatus: () => Promise<ControlStatus>,
  options: {
    retryMs: number;
    deadline: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  }
): Promise<ControlStatus | undefined> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));

  while (status.physical === 'stopping') {
    const remaining = options.deadline - now();
    if (remaining <= 0) return undefined;
    await sleep(Math.min(options.retryMs, remaining));
    status = await getStatus();
  }

  return status;
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

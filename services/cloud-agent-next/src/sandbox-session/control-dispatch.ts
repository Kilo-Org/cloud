import { withTimeout } from '@kilocode/worker-utils';
import type { ConnectionState, PhysicalState } from '../sandbox-control/status-projection.js';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  controlErrorSchema,
  type ResponseFrame,
} from '../shared/sandbox-control-protocol.js';

export const SESSION_DELIVERY_TIMEOUT_MS =
  DEADLINE_MS.startup + SANDBOX_CONTROL_ATTACH_TIMEOUT_MS + 2 * SANDBOX_CONTROL_REQUEST_TIMEOUT_MS;

export async function withDeliveryDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
  timeoutMs = SANDBOX_CONTROL_REQUEST_TIMEOUT_MS
): Promise<T> {
  const now = Date.now();
  const remaining = deadlineAt - now;
  if (remaining <= 0) throw new Error('Session delivery deadline exceeded');
  const operationDeadlineAt = Math.min(deadlineAt, now + timeoutMs);
  try {
    return await withTimeout(
      operation(),
      operationDeadlineAt - now,
      'Session delivery operation timed out'
    );
  } catch (error) {
    if (Date.now() >= operationDeadlineAt) {
      throw new Error('Session delivery operation timed out');
    }
    throw error;
  }
}

export function controlRequestResult(response: ResponseFrame): unknown {
  if (response.ok) return response.result;
  const error = controlErrorSchema.parse(response.error);
  throw Object.assign(new Error(error.message), error);
}

export function isRetryableDeliveryError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'retryable' in error &&
    error.retryable === true &&
    (!('overloaded' in error) || error.overloaded !== true)
  );
}

export type ControlDispatchDisposition =
  | { action: 'send' }
  | { action: 'wait' }
  | { action: 'fail'; reason: QueueFailureReason };

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
  | 'preparation_timeout'
  | 'runtime_unhealthy'
  | 'missing_metadata';

export function controlDispatchDisposition(status: ControlStatus): ControlDispatchDisposition {
  if (status.physical === 'unknown') return { action: 'fail', reason: 'provider_unknown' };
  if (status.physical === 'failed' || status.physical === 'stopped') {
    return { action: 'fail', reason: 'environment_failed' };
  }
  if (status.physical === 'stopping') return { action: 'wait' };
  if (status.connection === 'ready') return { action: 'send' };
  return { action: 'wait' };
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
    case 'preparation_timeout':
      return 'Environment preparation timed out';
    case 'runtime_unhealthy':
      return 'The session runtime stopped responding';
    default:
      return 'Environment failed';
  }
}

import { withTimeout } from '@kilocode/worker-utils';
import type { ConnectionState, PhysicalState } from '../sandbox-control/status-projection.js';
import { DEADLINE_MS } from '../sandbox-control/deadlines.js';
import type { SandboxProviderFailureReason } from '../persistence/SandboxControl.js';
import {
  SANDBOX_CONTROL_ATTACH_TIMEOUT_MS,
  SANDBOX_CONTROL_REQUEST_TIMEOUT_MS,
  controlErrorCodes,
  controlErrorSchema,
  type ControlError,
  type ResponseFrame,
} from '../shared/sandbox-control-protocol.js';

export const SESSION_DELIVERY_TIMEOUT_MS =
  DEADLINE_MS.startup + SANDBOX_CONTROL_ATTACH_TIMEOUT_MS + 2 * SANDBOX_CONTROL_REQUEST_TIMEOUT_MS;

export class ControlRequestError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly admission: ControlError['admission'];

  constructor(error: ControlError) {
    super(error.message);
    this.name = 'ControlRequestError';
    this.code = error.code;
    this.retryable = error.retryable;
    this.admission = error.admission;
  }
}

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
    if (error instanceof ControlRequestError) throw error;
    if (Date.now() >= operationDeadlineAt) {
      throw new Error('Session delivery operation timed out');
    }
    throw error;
  }
}

export function controlRequestResult(response: ResponseFrame): unknown {
  if (response.ok) return response.result;
  throw new ControlRequestError(controlErrorSchema.parse(response.error));
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

export function deliveryErrorLogFields(error: unknown) {
  return {
    errorCode:
      error instanceof ControlRequestError
        ? (controlErrorCodes.find(code => code === error.code) ?? 'unknown_control_error')
        : 'transport_or_internal_error',
    retryable: isRetryableDeliveryError(error),
  };
}

export type ControlDispatchDisposition =
  | { action: 'send' }
  | { action: 'wait' }
  | { action: 'fail'; reason: QueueFailureReason };

export type QueueFailureReason =
  | 'environment_failed'
  | 'provider_unknown'
  | 'attach_exhausted'
  | 'prompt_exhausted'
  | 'accepted_overdue'
  | 'preparation_timeout'
  | 'runtime_unhealthy'
  | 'missing_metadata'
  | SandboxProviderFailureReason;

type ControlStatus = {
  connection: ConnectionState;
  physical: PhysicalState;
  failureReason?: SandboxProviderFailureReason;
};

export function controlDispatchDisposition(status: ControlStatus): ControlDispatchDisposition {
  if (status.failureReason !== undefined) return { action: 'fail', reason: status.failureReason };
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

  while (status.physical === 'stopping' && status.failureReason === undefined) {
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
    case 'byoc_credential_missing':
      return 'Vercel credentials were removed. Reconfigure compute and start a new session.';
    case 'byoc_vercel_not_ready':
      return 'Vercel compute setup is not ready. Finish setup or contact an organization admin.';
    case 'byoc_vercel_forbidden':
      return 'Vercel access was denied. Check the token, team, and project permissions.';
    case 'byoc_vercel_capacity':
      return 'Vercel capacity or spend limits blocked this sandbox. Check the project limits.';
    case 'onprem_unavailable':
      return 'The selected on-prem installation is unavailable. Contact an organization admin.';
    case 'onprem_lifetime_exhausted':
      return 'The on-prem sandbox reached its fixed lifetime limit.';
    default:
      return 'Environment failed';
  }
}

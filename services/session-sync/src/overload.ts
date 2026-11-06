import { fail } from './protocol';

/** The platform may omit flags when an exception crosses an RPC boundary. */
export function isOverloaded(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  if ('overloaded' in error && error.overloaded === true) return true;
  if (!('message' in error) || typeof error.message !== 'string') return false;
  return (
    error.message.startsWith('Durable Object is overloaded.') ||
    error.message ===
      'Your account is generating too much load on Durable Objects. Please back off and try again later.'
  );
}

export type FailureCause =
  | 'none'
  | 'application_queue'
  | 'queued_requests'
  | 'queued_bytes'
  | 'queue_timeout'
  | 'object_rate'
  | 'account_rate'
  | 'platform_unknown'
  | 'watch_budget'
  | 'typed_result'
  | 'unknown';

/** Classifies platform text without retaining or emitting the original message. */
export function failureCause(error: unknown): FailureCause {
  if (error !== null && typeof error === 'object' && 'message' in error) {
    const message = error.message;
    if (message === 'Durable Object is overloaded. Too many requests queued.')
      return 'queued_requests';
    if (message === 'Durable Object is overloaded. Too much data queued.') return 'queued_bytes';
    if (message === 'Durable Object is overloaded. Requests queued for too long.')
      return 'queue_timeout';
    if (
      message ===
      'Durable Object is overloaded. Too many requests for the same object within a 10 second window.'
    )
      return 'object_rate';
    if (
      message ===
      'Your account is generating too much load on Durable Objects. Please back off and try again later.'
    )
      return 'account_rate';
    if (message === 'Presence watch budget exceeded') return 'watch_budget';
  }
  return isOverloaded(error) ? 'platform_unknown' : 'unknown';
}

/** Do not carry a retryable flag into the immediate RPC retry policy. */
export class ServiceOverloaded extends Error {
  constructor() {
    super('Session synchronization is temporarily overloaded');
  }
}

export function rpcError(error: unknown): unknown {
  return isOverloaded(error) ? new ServiceOverloaded() : error;
}

export function overloaded() {
  return fail('service_overloaded', 'Session synchronization is temporarily overloaded', {
    retryAt: Date.now() + 3000,
  });
}

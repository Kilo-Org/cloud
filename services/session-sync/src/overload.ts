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

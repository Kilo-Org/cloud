/**
 * Platform failures a retry can clear.
 *
 * A Durable Object hop fails for two very different reasons: the object, its
 * storage or the platform carrying the request was momentarily busy, or the
 * operation itself rejected. The caller's answer differs — the first is
 * "try again", the second is a defect or a refusal — so the classification
 * lives here instead of being re-derived from message text at every call site.
 *
 * Cloudflare marks its own transient failures with `retryable: true` and its
 * infrastructure overloads with `overloaded: true` when the flag survives the
 * RPC boundary; the text checks below cover the same families for the cases
 * where it does not (cross-colo RPC drops the flags).
 * Both are platform text, never application text, so an application error is
 * never retryable by accident.
 */

const NETWORK_CONNECTION_LOST_MESSAGE = 'Network connection lost.';

const TRANSIENT_PLATFORM_MESSAGES: readonly string[] = [
  'Your account is generating too much load on Durable Objects. Please back off and try again later.',
  "Durable Object's isolate exceeded its memory limit and was reset.",
  'Durable Object reset because its code was updated.',
  'Durable Object reset because its code was updated',
  NETWORK_CONNECTION_LOST_MESSAGE,
];

const OVERLOADED_PREFIX = 'Durable Object is overloaded.';

/**
 * True when `error` is a Durable Object / platform failure that a retry can
 * clear, false for everything else (including an operation that rejected).
 */
export function isTransientDurableObjectFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  if ('retryable' in error && error.retryable === true) return true;
  // Cloudflare marks an infrastructure overload with `overloaded` rather than
  // `retryable` (an overload must not be retried immediately), and it may drop
  // either flag when the exception crosses an RPC boundary. The caller's answer
  // is still "come back later", so it belongs here; the immediate retry loop
  // keys on `retryable` alone.
  if ('overloaded' in error && error.overloaded === true) return true;
  if (!('message' in error) || typeof error.message !== 'string') return false;
  const message = error.message;
  return (
    message.startsWith(OVERLOADED_PREFIX) ||
    TRANSIENT_PLATFORM_MESSAGES.some(candidate => message.startsWith(candidate))
  );
}

/**
 * True only for the runtime's connection-lost transport error. Cloudflare
 * raises this exact text when a client stream or a Durable Object connection
 * closes mid-request, so the message itself proves the connection closed;
 * application code never raises it. Matches the exact platform text only,
 * not other transient failures or application errors.
 */
export function isNetworkConnectionLost(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    error.message === NETWORK_CONNECTION_LOST_MESSAGE
  );
}

/**
 * True when `error` is the retry scope's own deadline (`createRetryScope`
 * aborts with a `TimeoutError`), i.e. the hop did not answer in time. Absent
 * an answer the operation is unknown, not failed, so callers answer it the
 * same way they answer a transient platform failure.
 */
export function isDurableObjectRetryDeadline(error: unknown): boolean {
  // Matched by name rather than `instanceof Error`: the retry scope aborts with
  // a `DOMException`, whose prototype chain a runtime is not required to root
  // in `Error`. Only the scope raises this exact name for a hop deadline.
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'TimeoutError'
  );
}

/** Shared creation limits and watchdog batching constants for Gastown control-plane DOs. */

/** Maximum towns a single owner (user or organization) may hold. */
export const MAX_TOWNS_PER_OWNER = 50;

/** Maximum rigs a single town may hold. */
export const MAX_RIGS_PER_TOWN = 20;

/** Maximum town health checks the watchdog performs per alarm tick. */
export const WATCHDOG_BATCH_SIZE = 25;

/** How soon after a full batch the watchdog re-arms to continue the cycle. */
export const WATCHDOG_BATCH_RETRY_MS = 1_000;

export type CreationLimitCode = 'TOWN_LIMIT' | 'RIG_LIMIT';

/**
 * Marker prefix the DO's message carries when legacy RPC serialization
 * flattens the error (class lost, name folded into the message).
 */
const CREATION_LIMIT_PREFIX = 'CreationLimitError: ';

/** Strip the serialization prefix so callers see only the user-facing message. */
function stripCreationLimitPrefix(message: string): string {
  return message.startsWith(CREATION_LIMIT_PREFIX)
    ? message.slice(CREATION_LIMIT_PREFIX.length)
    : message;
}

/**
 * Type guard safe across Durable Object RPC boundaries. Depending on the
 * serialization path the error arrives either as a class instance, as a
 * plain `Error` with the original `name`, or fully flattened with the name
 * folded into the message.
 */
export function isCreationLimitError(err: unknown): err is CreationLimitError {
  if (err instanceof CreationLimitError) return true;
  const e = err as Error | null;
  if (!e) return false;
  if (e.name === 'CreationLimitError') {
    // Normalize a flattened message in place so the router forwards the
    // user-facing text without the marker prefix.
    e.message = stripCreationLimitPrefix(e.message);
    return true;
  }
  if (typeof e.message === 'string' && e.message.startsWith(CREATION_LIMIT_PREFIX)) {
    e.message = stripCreationLimitPrefix(e.message);
    return true;
  }
  return false;
}

/**
 * Thrown by control-plane DOs when a creation would exceed a per-owner or
 * per-town limit. Carries a user-facing message the tRPC layer forwards.
 */
export class CreationLimitError extends Error {
  constructor(
    readonly code: CreationLimitCode,
    message: string
  ) {
    super(message);
    this.name = 'CreationLimitError';
  }
}

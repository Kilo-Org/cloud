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
 * Type guard safe across Durable Object RPC boundaries, where thrown
 * errors arrive as plain `Error` instances with the original `name`.
 */
export function isCreationLimitError(err: unknown): err is CreationLimitError {
  return err instanceof CreationLimitError || (err as Error | null)?.name === 'CreationLimitError';
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

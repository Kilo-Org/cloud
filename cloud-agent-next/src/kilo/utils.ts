import type { ExecutionId } from '../types/ids.js';

/**
 * Type-safe extraction of the ULID portion from an execution ID.
 */
export const extractUlid = (id: ExecutionId): string => {
  return id.replace(/^exc_/, '');
};

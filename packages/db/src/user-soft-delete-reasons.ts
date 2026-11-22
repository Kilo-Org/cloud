/**
 * Blocked-reason vocabulary for soft-deleted and deletion-in-progress users.
 *
 * Kept free of `drizzle-orm` so browser bundles can import it; the SQL
 * predicate lives in `./user-soft-delete`.
 */

export const SOFT_DELETED_BLOCK_REASON_PREFIX = 'soft-deleted at ';
export const DELETION_IN_PROGRESS_BLOCK_REASON_PREFIX = 'deletion-in-progress at ';

/**
 * The ordered set of reasons that mean a user is gone or being deleted. Both the
 * in-memory predicate below and the SQL predicate in `./user-soft-delete` read this
 * list, so a new blocked-reason prefix is added here once and both paths follow.
 */
export const GONE_OR_DELETING_BLOCK_REASON_PREFIXES = [
  SOFT_DELETED_BLOCK_REASON_PREFIX,
  DELETION_IN_PROGRESS_BLOCK_REASON_PREFIX,
] as const;

export function createSoftDeletedBlockedReason(at = new Date()): string {
  return `${SOFT_DELETED_BLOCK_REASON_PREFIX}${at.toISOString()}`;
}

export function isSoftDeletedBlockedReason(reason: string | null): boolean {
  return reason?.startsWith(SOFT_DELETED_BLOCK_REASON_PREFIX) ?? false;
}

export function createDeletionInProgressBlockedReason(at = new Date()): string {
  return `${DELETION_IN_PROGRESS_BLOCK_REASON_PREFIX}${at.toISOString()}`;
}

export function isDeletionInProgressBlockedReason(reason: string | null): boolean {
  return reason?.startsWith(DELETION_IN_PROGRESS_BLOCK_REASON_PREFIX) ?? false;
}

export function isGoneOrDeletingBlockedReason(reason: string | null): boolean {
  return GONE_OR_DELETING_BLOCK_REASON_PREFIXES.some(prefix => reason?.startsWith(prefix) ?? false);
}

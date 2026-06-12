export const SOFT_DELETED_BLOCK_REASON_PREFIX = 'soft-deleted at ';

export function createSoftDeletedBlockedReason(at = new Date()): string {
  return `${SOFT_DELETED_BLOCK_REASON_PREFIX}${at.toISOString()}`;
}

export function isSoftDeletedBlockedReason(reason: string | null): boolean {
  return reason?.startsWith(SOFT_DELETED_BLOCK_REASON_PREFIX) ?? false;
}

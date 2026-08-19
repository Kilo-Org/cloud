import { describe, expect, it } from '@jest/globals';
import {
  DELETION_IN_PROGRESS_BLOCK_REASON_PREFIX,
  SOFT_DELETED_BLOCK_REASON_PREFIX,
  createDeletionInProgressBlockedReason,
  createSoftDeletedBlockedReason,
  isDeletionInProgressBlockedReason,
  isGoneOrDeletingBlockedReason,
  isSoftDeletedBlockedReason,
} from './user-soft-delete';

describe('user-soft-delete blocked-reason helpers', () => {
  const at = new Date('2026-08-11T12:00:00.000Z');

  it('creates and detects fully-gone soft-deleted reasons only', () => {
    const reason = createSoftDeletedBlockedReason(at);
    expect(reason).toBe(`${SOFT_DELETED_BLOCK_REASON_PREFIX}2026-08-11T12:00:00.000Z`);
    expect(isSoftDeletedBlockedReason(reason)).toBe(true);
    expect(isSoftDeletedBlockedReason(null)).toBe(false);
    expect(isSoftDeletedBlockedReason('abuse')).toBe(false);
    expect(isSoftDeletedBlockedReason(createDeletionInProgressBlockedReason(at))).toBe(false);
  });

  it('creates and detects deletion-in-progress reasons', () => {
    const reason = createDeletionInProgressBlockedReason(at);
    expect(reason).toBe(`${DELETION_IN_PROGRESS_BLOCK_REASON_PREFIX}2026-08-11T12:00:00.000Z`);
    expect(isDeletionInProgressBlockedReason(reason)).toBe(true);
    expect(isDeletionInProgressBlockedReason(null)).toBe(false);
    expect(isDeletionInProgressBlockedReason('abuse')).toBe(false);
    expect(isDeletionInProgressBlockedReason(createSoftDeletedBlockedReason(at))).toBe(false);
  });

  it('treats either prefix as gone-or-deleting', () => {
    expect(isGoneOrDeletingBlockedReason(createSoftDeletedBlockedReason(at))).toBe(true);
    expect(isGoneOrDeletingBlockedReason(createDeletionInProgressBlockedReason(at))).toBe(true);
    expect(isGoneOrDeletingBlockedReason(null)).toBe(false);
    expect(isGoneOrDeletingBlockedReason('abuse')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import {
  CODE_REVIEW_STATUS_LABELS,
  CODE_REVIEW_STATUSES,
  canRetriggerReview,
  hasInFlightReview,
  isCancellableReviewStatus,
  isInFlightReviewStatus,
  isRetriggerableReviewStatus,
} from './status';

// No prior test covered this logic directly (it was duplicated inline as
// Set/array literals across mobile and web) — added minimal coverage per
// the moved-logic contract: in-flight/cancellable/retriggerable predicates
// must agree with each other and every status must have a label.
describe('CODE_REVIEW_STATUS_LABELS', () => {
  it('has a label for every status', () => {
    for (const status of CODE_REVIEW_STATUSES) {
      expect(CODE_REVIEW_STATUS_LABELS[status]).toBeTruthy();
    }
  });
});

describe('isInFlightReviewStatus / isCancellableReviewStatus', () => {
  it('matches pending, queued, running', () => {
    expect(isInFlightReviewStatus('pending')).toBe(true);
    expect(isInFlightReviewStatus('queued')).toBe(true);
    expect(isInFlightReviewStatus('running')).toBe(true);
    expect(isInFlightReviewStatus('completed')).toBe(false);
    expect(isInFlightReviewStatus('failed')).toBe(false);
    expect(isInFlightReviewStatus('cancelled')).toBe(false);
    expect(isInFlightReviewStatus('interrupted')).toBe(false);
  });

  it('agrees with isCancellableReviewStatus for every status', () => {
    for (const status of CODE_REVIEW_STATUSES) {
      expect(isCancellableReviewStatus(status)).toBe(isInFlightReviewStatus(status));
    }
  });
});

describe('isRetriggerableReviewStatus', () => {
  it('matches failed, cancelled, interrupted', () => {
    expect(isRetriggerableReviewStatus('failed')).toBe(true);
    expect(isRetriggerableReviewStatus('cancelled')).toBe(true);
    expect(isRetriggerableReviewStatus('interrupted')).toBe(true);
    expect(isRetriggerableReviewStatus('pending')).toBe(false);
    expect(isRetriggerableReviewStatus('queued')).toBe(false);
    expect(isRetriggerableReviewStatus('running')).toBe(false);
    expect(isRetriggerableReviewStatus('completed')).toBe(false);
  });
});

describe('canRetriggerReview', () => {
  it('is false for a review cancelled because a newer commit replaced it', () => {
    expect(canRetriggerReview({ status: 'cancelled', terminal_reason: 'superseded' })).toBe(false);
  });

  it('is true for a cancelled review the user stopped', () => {
    expect(canRetriggerReview({ status: 'cancelled', terminal_reason: 'user_cancelled' })).toBe(
      true
    );
  });

  it('is true for a cancelled review with no terminal reason', () => {
    expect(canRetriggerReview({ status: 'cancelled', terminal_reason: null })).toBe(true);
    expect(canRetriggerReview({ status: 'cancelled', terminal_reason: undefined })).toBe(true);
  });

  it('is true for failed and interrupted reviews with a retryable reason', () => {
    expect(canRetriggerReview({ status: 'failed', terminal_reason: 'timeout' })).toBe(true);
    expect(canRetriggerReview({ status: 'interrupted', terminal_reason: 'interrupted' })).toBe(
      true
    );
  });

  it('is false for pending, queued, running, and completed', () => {
    expect(canRetriggerReview({ status: 'pending', terminal_reason: null })).toBe(false);
    expect(canRetriggerReview({ status: 'queued', terminal_reason: null })).toBe(false);
    expect(canRetriggerReview({ status: 'running', terminal_reason: null })).toBe(false);
    expect(canRetriggerReview({ status: 'completed', terminal_reason: null })).toBe(false);
  });
});

describe('hasInFlightReview', () => {
  it('is true when any review is pending, queued, or running', () => {
    expect(hasInFlightReview([{ status: 'completed' }, { status: 'running' }])).toBe(true);
  });

  it('is false when no review is in flight', () => {
    expect(hasInFlightReview([{ status: 'completed' }, { status: 'failed' }])).toBe(false);
  });

  it('is false for an empty list', () => {
    expect(hasInFlightReview([])).toBe(false);
  });
});

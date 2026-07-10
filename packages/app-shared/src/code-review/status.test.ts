import { describe, expect, it } from 'vitest';

import {
  CODE_REVIEW_STATUS_LABELS,
  CODE_REVIEW_STATUSES,
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

// Ported from apps/mobile/src/lib/hooks/use-code-reviews.ts (hasInFlightReview),
// apps/mobile/src/components/code-reviewer/review-detail-screen.tsx (CANCELLABLE_STATUSES,
// RETRIGGERABLE_STATUSES), apps/mobile/src/components/code-reviewer/review-list-screen.tsx
// (STATUS_META labels), and apps/web/src/components/code-reviews/CodeReviewJobsCard.tsx /
// CodeReviewDetailClient.tsx (statusConfig labels, in-flight/cancellable/retriggerable inline
// sets). All four copies used the identical status lists — verified while porting.
export const CODE_REVIEW_STATUSES = [
  'pending',
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type CodeReviewStatus = (typeof CODE_REVIEW_STATUSES)[number];

// Label strings only — both web copies and mobile's STATUS_META agree on
// these exact strings. Icons/tone classes are platform-specific and stay
// local to each app.
export const CODE_REVIEW_STATUS_LABELS: Record<CodeReviewStatus, string> = {
  pending: 'Pending',
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

// In-flight and cancellable currently mean the exact same set of statuses
// everywhere this was duplicated (mobile's CANCELLABLE_STATUSES, web's
// polling/cancel-button gates) — one underlying set, two names for the two
// call-site meanings.
const IN_FLIGHT_STATUSES = new Set<CodeReviewStatus>(['pending', 'queued', 'running']);
const RETRIGGERABLE_STATUSES = new Set<CodeReviewStatus>(['failed', 'cancelled', 'interrupted']);

export function isCodeReviewStatus(status: string): status is CodeReviewStatus {
  return (CODE_REVIEW_STATUSES as readonly string[]).includes(status);
}

export function isInFlightReviewStatus(status: string): boolean {
  return isCodeReviewStatus(status) && IN_FLIGHT_STATUSES.has(status);
}

// Same semantics as isInFlightReviewStatus today — kept as a separate,
// clearly-named predicate since the two call sites (polling vs. showing a
// Cancel button) are conceptually distinct even though the sets currently
// match exactly.
export const isCancellableReviewStatus = isInFlightReviewStatus;

export function isRetriggerableReviewStatus(status: string): boolean {
  return isCodeReviewStatus(status) && RETRIGGERABLE_STATUSES.has(status);
}

export function hasInFlightReview(reviews: readonly { status: string }[]): boolean {
  return reviews.some(review => isInFlightReviewStatus(review.status));
}

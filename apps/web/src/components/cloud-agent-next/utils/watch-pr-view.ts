import type { WatchPrProjection } from '@/lib/cloud-agent/watch-pr-events';

export function canEnablePrWatch(pr: { platform: string; state: string }, canEnable: boolean) {
  return pr.platform === 'github' && (pr.state === 'open' || pr.state === 'draft') && canEnable;
}

export function watchPrObservationLabel(projection: WatchPrProjection) {
  if (projection.needsAttention || projection.ambiguous || projection.truncated) {
    return 'Needs attention';
  }
  if (projection.pending.length > 0) return 'Observed problems';
  return 'No observed problems';
}

export const watchPrProblemLabels: Record<WatchPrProjection['pending'][number]['reason'], string> =
  {
    reviewer_verification_required: 'Review feedback requires verification',
    review_blocker: 'Review blocker observed',
    failed_check: 'Failed check observed',
    failed_status: 'Failed commit status observed',
    base_changed: 'Base branch changed',
  };

export function validWatchPrPreferences(
  model: string,
  hours: number,
  perProblem: number,
  total: number
) {
  return (
    model.trim().length > 0 &&
    model.trim().length <= 200 &&
    Number.isFinite(hours) &&
    hours >= 1 &&
    hours <= 24 &&
    Number.isInteger(perProblem) &&
    perProblem >= 1 &&
    perProblem <= 2 &&
    Number.isInteger(total) &&
    total >= perProblem &&
    total <= 10
  );
}

import type { WatchPrProjection } from '@/lib/cloud-agent/watch-pr-events';
import { parsePullRequestUrl } from '@/lib/integrations/platforms/github/pr-link-identity';
import type { AssociatedPr } from './github-pr-link';

export function watchPrQueryInput(
  sessionId: string,
  pr: Pick<AssociatedPr, 'url' | 'number' | 'platform'>
) {
  const parsed = parsePullRequestUrl(pr.url);
  if (pr.platform !== 'github' || parsed?.host !== 'github.com' || parsed.number !== pr.number)
    return null;
  return { sessionId, expectedRepoUrl: parsed.repoUrl, expectedPrNumber: parsed.number };
}

export function watchPrMatchesIdentity(
  watch: { repo_url: string; pr_number: number },
  input: ReturnType<typeof watchPrQueryInput>
) {
  return (
    input !== null &&
    watch.repo_url === input.expectedRepoUrl &&
    watch.pr_number === input.expectedPrNumber
  );
}

export function watchPrExpiresAt(hours: number, now = Date.now()) {
  const durationMs = hours * 60 * 60 * 1000 - (hours >= 24 ? 5 * 60 * 1000 : 0);
  return new Date(now + durationMs).toISOString();
}

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

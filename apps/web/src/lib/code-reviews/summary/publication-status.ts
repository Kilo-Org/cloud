import { CodeReviewPublicationStatus } from '@kilocode/db/schema-types';
import {
  COUNCIL_VERDICT_BLOCK_END,
  COUNCIL_VERDICT_BLOCK_START,
} from '@kilocode/worker-utils/code-review-council';
import { getCurrentReviewSummaryForContext } from './history';

const KILO_REVIEW_MARKER = '<!-- kilo-review -->';

export type CodeReviewPublicationObservation =
  | { kind: 'not_applicable' }
  | { kind: 'unknown' }
  | {
      kind: 'summary';
      summaryBody: string | null;
      previousSummaryBody: string | null;
      previousSummaryObserved: boolean | null;
    };

const COUNCIL_VERDICT_BLOCK_PATTERN = new RegExp(
  `${COUNCIL_VERDICT_BLOCK_START}[\\s\\S]*?${COUNCIL_VERDICT_BLOCK_END}`,
  'g'
);

function normalizeSummaryBody(body: string): string {
  return getCurrentReviewSummaryForContext(body.replace(COUNCIL_VERDICT_BLOCK_PATTERN, '')).trim();
}

export function classifyCodeReviewPublication(
  observation: CodeReviewPublicationObservation
): CodeReviewPublicationStatus {
  if (observation.kind === 'not_applicable') {
    return CodeReviewPublicationStatus.NotApplicable;
  }

  if (observation.kind === 'unknown') {
    return CodeReviewPublicationStatus.Unknown;
  }

  const { summaryBody, previousSummaryBody, previousSummaryObserved } = observation;

  if (summaryBody === null || !summaryBody.includes(KILO_REVIEW_MARKER)) {
    return CodeReviewPublicationStatus.Missing;
  }

  const baselineUnavailable =
    previousSummaryObserved === false ||
    (previousSummaryObserved === null && previousSummaryBody === null);

  if (baselineUnavailable) {
    return CodeReviewPublicationStatus.Unknown;
  }

  if (previousSummaryBody === null) {
    return CodeReviewPublicationStatus.Published;
  }

  const currentSummary = normalizeSummaryBody(summaryBody);
  const previousSummary = normalizeSummaryBody(previousSummaryBody);

  return currentSummary === previousSummary
    ? CodeReviewPublicationStatus.Unchanged
    : CodeReviewPublicationStatus.Published;
}

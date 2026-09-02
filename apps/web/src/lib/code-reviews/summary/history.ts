import {
  buildPreviousReviewSummaryHistory,
  stripReviewSummaryHistory,
} from '@kilocode/worker-utils/review-summary-cleaning';
import { stripReviewSummaryFooter } from './usage-footer';

export {
  REVIEW_SUMMARY_HISTORY_START,
  REVIEW_SUMMARY_HISTORY_END,
  REVIEW_SUMMARY_HISTORY_ENTRY,
  buildPreviousReviewSummaryHistory,
  getCurrentReviewSummaryForContext,
  stripReviewSummaryHistory,
} from '@kilocode/worker-utils/review-summary-cleaning';

const DEFAULT_HISTORY_MAX_CHARACTERS = 24_000;

type AppendPreviousReviewSummaryHistoryOptions = {
  maxBodyCharacters?: number;
  reservedCharacters?: number;
};

export function appendPreviousReviewSummaryHistory(
  body: string,
  previousSummaryBody: string | null,
  previousHeadSha: string | null,
  options: AppendPreviousReviewSummaryHistoryOptions = {}
): string {
  if (!previousSummaryBody) {
    return body;
  }

  const currentSummary = stripReviewSummaryFooter(stripReviewSummaryHistory(body)).trimEnd();
  const separatorCharacters = currentSummary ? 2 : 0;
  const availableHistoryCharacters =
    options.maxBodyCharacters === undefined
      ? DEFAULT_HISTORY_MAX_CHARACTERS
      : Math.max(
          0,
          Math.min(
            DEFAULT_HISTORY_MAX_CHARACTERS,
            options.maxBodyCharacters -
              currentSummary.length -
              separatorCharacters -
              (options.reservedCharacters ?? 0)
          )
        );
  const history = buildPreviousReviewSummaryHistory(previousSummaryBody, {
    previousHeadSha,
    maxCharacters: availableHistoryCharacters,
  });

  if (!history) {
    return currentSummary;
  }

  return currentSummary ? `${currentSummary}\n\n${history}` : history;
}

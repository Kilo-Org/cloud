import { i18n } from '@/i18n';
import { PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';
import { knownServerErrorMessage } from '@/lib/server-error-copy';
import { isTerminalTrpcCode, readTrpcErrorField } from '@/lib/trpc-error';

import { type WatchedStartFailure } from './deadline-watched-start';

type ManualReviewStartPlatform = 'github' | 'gitlab';

/**
 * Catalog keys for a manual-review start failure, one per tRPC code the
 * `createManualReviewJob` procedures throw — `apps/web/src/lib/code-reviews/
 * manual-code-review-jobs.ts` and the org router's membership and trial gates.
 * The message text the server sends is English, so the screen renders the
 * localized copy for the code instead, unless the sentence is one the app
 * already explains (`knownServerErrorMessage`). `startFailed` covers a
 * transport failure (no code at all), and an unrecognized code keeps the
 * generic `unknownError`.
 */
const MANUAL_REVIEW_START_FAILURE_KEYS = {
  // The change could not be read: a provider 404, no connected installation
  // that can read it, or a missing organization.
  NOT_FOUND: 'codeReviewer.manualReview.startNotFound',
  TOO_MANY_REQUESTS: 'codeReviewer.manualReview.startRateLimited',
  // A member-role denial. An organization whose trial has expired carries a
  // sentence the app explains instead (`common.organizationTrialEnded`).
  FORBIDDEN: 'codeReviewer.manualReview.startNotAllowed',
  UNAUTHORIZED: 'codeReviewer.manualReview.startNotAllowed',
  // No connected provider, or only the read-only ("lite") app connected.
  PRECONDITION_FAILED: 'codeReviewer.manualReview.startProviderNeedsAttention',
  // A provider-publishing job is already active for this change.
  CONFLICT: 'codeReviewer.manualReview.startAlreadyRunning',
  // Invalid URL, closed request, draft request, unsupported host.
  BAD_REQUEST: 'codeReviewer.manualReview.startRejected',
  // Provider returned an unexpected response or could not be reached.
  BAD_GATEWAY: 'codeReviewer.manualReview.startProviderUnavailable',
} as const;

type ManualReviewStartFailureKey =
  | (typeof MANUAL_REVIEW_START_FAILURE_KEYS)[keyof typeof MANUAL_REVIEW_START_FAILURE_KEYS]
  | 'codeReviewer.manualReview.startFailed'
  | 'codeReviewer.unknownError';

/** Whether the code has its own sentence, narrowing to its map key. */
function isMappedStartCode(code: string): code is keyof typeof MANUAL_REVIEW_START_FAILURE_KEYS {
  return Object.hasOwn(MANUAL_REVIEW_START_FAILURE_KEYS, code);
}

/** The catalog key for a failed start: by error code, never by message text. */
function manualReviewStartFailureKey(error: unknown): ManualReviewStartFailureKey {
  const code = readTrpcErrorField(error, 'code');
  if (code === undefined) {
    return 'codeReviewer.manualReview.startFailed';
  }
  return isMappedStartCode(code)
    ? MANUAL_REVIEW_START_FAILURE_KEYS[code]
    : 'codeReviewer.unknownError';
}

/**
 * The localized explanation for a failed start, and whether sending the same
 * request again can succeed. The provider name is the brand string the
 * platform picker shows (untranslated in every catalog); the request noun
 * follows the platform's own term (GitHub: pull request, GitLab: merge
 * request).
 *
 * The organization trial gate refuses a start with `FORBIDDEN` and the
 * sentence `Organization trial has expired.`, which the app already explains
 * (`common.organizationTrialEnded`), so a recognized server sentence wins over
 * the code's generic line — the same rule `reviewerSaveFailure` applies to a
 * refused config save. A denial the app cannot explain keeps the code's copy,
 * and a terminal code drops the retry: resending the same request cannot make
 * a lapsed plan or a lost role valid.
 */
export function manualReviewStartFailure(
  error: unknown,
  platform: ManualReviewStartPlatform
): WatchedStartFailure {
  const variables = {
    provider: PLATFORM_CAPABILITIES[platform].label,
    requestNoun: i18n.t(platform === 'gitlab' ? 'common.mergeRequest' : 'common.pullRequest'),
  };
  return {
    message:
      knownServerErrorMessage(error) ?? i18n.t(manualReviewStartFailureKey(error), variables),
    retryable: !isTerminalTrpcCode(readTrpcErrorField(error, 'code')),
  };
}

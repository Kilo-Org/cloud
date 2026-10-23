import { i18n } from '@/i18n';
import { PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';

type ManualReviewStartPlatform = 'github' | 'gitlab';

/**
 * Catalog keys for a manual-review start failure, one per tRPC code the
 * `createManualReviewJob` procedures throw — `apps/web/src/lib/code-reviews/
 * manual-code-review-jobs.ts` and the org router's membership check. The
 * message text the server sends is English, so the screen renders the
 * localized copy for the code instead. `startFailed` covers a transport
 * failure (no code at all), and an unrecognized code keeps the generic
 * `unknownError`.
 */
export const MANUAL_REVIEW_START_FAILURE_KEYS = {
  // Provider cannot read the pull/merge request: 404 from the provider, no
  // installation that can read it, or every connected one failed.
  NOT_FOUND: 'codeReviewer.manualReview.startNotFound',
  TOO_MANY_REQUESTS: 'codeReviewer.manualReview.startRateLimited',
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

export type ManualReviewStartFailureKey =
  | (typeof MANUAL_REVIEW_START_FAILURE_KEYS)[keyof typeof MANUAL_REVIEW_START_FAILURE_KEYS]
  | 'codeReviewer.manualReview.startFailed'
  | 'codeReviewer.unknownError';

/** The tRPC error code a rejected call carries, if any. */
function manualReviewStartErrorCode(error: unknown): string | undefined {
  // tRPC client errors carry the code on `data.code`; some wrappers keep it on
  // the error itself. The value is read, never trusted: an unrecognized or
  // absent code falls back to the generic copy below.
  const clientError = error as { data?: { code?: string }; code?: string } | null | undefined;
  return clientError?.data?.code ?? clientError?.code;
}

/** Whether the code has its own sentence, narrowing to its map key. */
function isMappedStartCode(code: string): code is keyof typeof MANUAL_REVIEW_START_FAILURE_KEYS {
  return Object.hasOwn(MANUAL_REVIEW_START_FAILURE_KEYS, code);
}

/** The catalog key for a failed start: by error code, never by message text. */
export function manualReviewStartFailureKey(error: unknown): ManualReviewStartFailureKey {
  const code = manualReviewStartErrorCode(error);
  if (code === undefined) {
    return 'codeReviewer.manualReview.startFailed';
  }
  return isMappedStartCode(code)
    ? MANUAL_REVIEW_START_FAILURE_KEYS[code]
    : 'codeReviewer.unknownError';
}

/**
 * The localized start-failure sentence. The provider name is the brand string
 * the platform picker shows (untranslated in every catalog); the request noun
 * follows the platform's own term (GitHub: pull request, GitLab: merge
 * request).
 */
export function manualReviewStartFailureMessage(
  error: unknown,
  platform: ManualReviewStartPlatform
): string {
  const variables = {
    provider: PLATFORM_CAPABILITIES[platform].label,
    requestNoun: i18n.t(platform === 'gitlab' ? 'common.mergeRequest' : 'common.pullRequest'),
  };
  return i18n.t(manualReviewStartFailureKey(error), variables);
}

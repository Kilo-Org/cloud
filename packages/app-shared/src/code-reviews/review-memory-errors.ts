// The server sentences the review-memory change-request path rejects with.
//
// Each value is a stable identity, not decoration: the web throws the table's
// sentence and the mobile app matches it whole to pick the localized copy it
// shows, so reword a value only together with the mapping in
// apps/mobile/src/lib/server-error-copy.ts. The reason names are what the web
// logs and what a test enumerates to notice a reason the app does not map yet.

export const REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY = {
  proposal_not_found: 'Review memory proposal not found.',
  change_request_in_progress: 'Review memory proposal is already being processed.',
  proposal_not_actionable: 'Review memory proposal can no longer be approved.',
  no_github_integration: 'No active GitHub integration has access to this repository.',
  missing_github_app_permissions:
    'The GitHub App needs contents:write and pull_requests:write permissions to open a REVIEW.md PR.',
  // The provider detail stays in the log drain: a forwarded API sentence is not
  // stable enough to match, and it is not the user's to read.
  change_request_failed: 'Kilo could not open the REVIEW.md pull request. Try again in a moment.',
  review_memory_disabled: 'Review memory is disabled for this platform.',
} as const;

export type ReviewMemoryChangeRequestErrorReason =
  keyof typeof REVIEW_MEMORY_CHANGE_REQUEST_ERROR_COPY;

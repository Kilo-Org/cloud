/**
 * Code Reviews - Constants
 *
 * Constants used throughout the code review system.
 */

// ============================================================================
// Review Configuration
// ============================================================================

/** Default model for code reviews */
export const DEFAULT_CODE_REVIEW_MODEL = 'anthropic/claude-sonnet-4.6';

/**
 * Default mode for cloud agent sessions
 */
export const DEFAULT_CODE_REVIEW_MODE = 'code' as const;

/**
 * PostHog flag gating the Custom Instructions -> REVIEW.md conversion flow (route + UI button).
 * A credit-spending, PR-opening action, so it stays behind a flag for staged rollout and a kill
 * switch. Server checks it via `isFeatureFlagEnabledOrDevelopment`; the UI via `useFeatureFlagEnabled`.
 */
export const CODE_REVIEW_MD_CONVERSION_FLAG = 'code-review-md-conversion';

/** Max REVIEW.md conversion sessions a single actor may start per rolling window (abuse cap). */
export const REVIEW_MD_CONVERSION_RATE_LIMIT = 30;
export const REVIEW_MD_CONVERSION_RATE_WINDOW_SECONDS = 60 * 60;

// ============================================================================
// Pagination
// ============================================================================

/**
 * Default limit for listing code reviews
 */
export const DEFAULT_LIST_LIMIT = 50;

/**
 * Maximum limit for listing code reviews
 */
export const MAX_LIST_LIMIT = 100;

/**
 * Default offset for pagination
 */
export const DEFAULT_LIST_OFFSET = 0;

// ============================================================================
// GitHub Webhook Events
// ============================================================================

/**
 * GitHub pull request actions that trigger code reviews
 */
export const CODE_REVIEW_TRIGGER_ACTIONS = ['opened', 'synchronize', 'reopened'] as const;

/**
 * GitHub webhook event type for pull requests
 */
export const GITHUB_PR_EVENT_TYPE = 'pull_request';

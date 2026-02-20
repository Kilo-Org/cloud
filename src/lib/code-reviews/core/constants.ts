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

// ============================================================================
// Sonnet 4.6 Review Promotion
// ============================================================================

export const REVIEW_PROMO_MODEL = 'anthropic/claude-sonnet-4.6';
export const REVIEW_PROMO_START = '2026-02-18T14:00:00Z'; // used only for admin logging
export const REVIEW_PROMO_END = '2026-02-25T14:00:00Z';

/** Single source of truth: is the free-review promo active for this request? */
export function isActiveReviewPromo(botId: string | undefined, model: string): boolean {
  if (botId !== 'reviewer') return false;
  if (model !== REVIEW_PROMO_MODEL) return false;

  return Date.now() < Date.parse(REVIEW_PROMO_END);
}

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

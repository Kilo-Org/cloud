/**
 * Code Reviews - Constants
 *
 * Constants used throughout the code review system.
 */

import { getActiveReviewPromotionModel } from '@/lib/models';

// ============================================================================
// Review Configuration
// ============================================================================

/**
 * Default model for code reviews.
 * Falls back to Claude Sonnet 4.5 when no promotion is active.
 */
const BASE_CODE_REVIEW_MODEL = 'anthropic/claude-sonnet-4.5';

/**
 * Returns the effective default model for code reviews.
 * If a review-only promotional model is currently active, it takes precedence.
 */
export function getDefaultCodeReviewModel(): string {
  const promoModel = getActiveReviewPromotionModel();
  return promoModel?.public_id ?? BASE_CODE_REVIEW_MODEL;
}

/**
 * Default mode for cloud agent sessions
 */
export const DEFAULT_CODE_REVIEW_MODE = 'code' as const;

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

/**
 * Code Reviews - Constants
 *
 * Constants used throughout the code review system.
 */

import { CLAUDE_SONNET_CURRENT_MODEL_ID } from '@/lib/model-constants';

// ============================================================================
// Review Configuration
// ============================================================================

/**
 * Default model for code reviews
 */
export const DEFAULT_CODE_REVIEW_MODEL = CLAUDE_SONNET_CURRENT_MODEL_ID;

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

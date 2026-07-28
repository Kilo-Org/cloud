/**
 * Centralized SecureStore key constants.
 *
 * All keys used with expo-secure-store should be defined here so they stay
 * consistent across reads, writes, and sign-out cleanup.
 * Keys must not be empty and contain only alphanumeric characters, ".", "-", and "_".
 */

export const AUTH_TOKEN_KEY = 'auth-token';
export const ORGANIZATION_STORAGE_KEY = 'selected-organization';
export const SESSION_FILTERS_KEY = 'agent-session-filters';
export const NOTIFICATION_PROMPT_SEEN_KEY = 'notification-prompt-seen';
export const LAST_ACTIVE_INSTANCE_KEY = 'last-active-chat-instance';
export const CONSENT_USER_KEY_PREFIX = 'consent-accepted-';
export const AGENT_MODEL_PREFERENCE_KEY = 'agent-model-preference';
export const REASONING_DEFAULT_EXPANDED_KEY = 'agent-reasoning-default-expanded';
export const REVIEW_REQUESTED_AT_KEY = 'store-review-requested-at';
export const PR_REVIEW_RECENTS_KEY = 'pr-review-recents';
export const PR_REVIEW_VIEWED_KEY = 'pr-review-viewed';
export const THEME_PREFERENCE_KEY = 'theme-preference';

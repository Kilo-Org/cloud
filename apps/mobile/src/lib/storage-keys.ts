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
/** One-time gate for the neutral post-success feedback prompt. */
export const FEEDBACK_LAST_ASKED_AT_KEY = 'feedback-last-asked-at';
export const PR_REVIEW_RECENTS_KEY = 'pr-review-recents';
export const PR_REVIEW_VIEWED_KEY = 'pr-review-viewed';
export const THEME_PREFERENCE_KEY = 'theme-preference';
export const LANGUAGE_PREFERENCE_KEY = 'language-preference';
/** One-shot screen to reopen after an RTL language reload. */
export const LANGUAGE_RETURN_TARGET_KEY = 'language-return-target';
/** Login email draft, persisted before an RTL language reload. */
export const LOGIN_EMAIL_DRAFT_KEY = 'login-email-draft';
/** Login SSO-recovery banner draft, persisted before an RTL language reload. */
export const LOGIN_SSO_RECOVERY_DRAFT_KEY = 'login-sso-recovery-draft';
export const KEEP_SCREEN_ON_KEY = 'keep-session-screen-on';
/** SQLCipher database key for the encrypted persistence store (DEC-01). */
export const PERSIST_DB_KEY = 'persist-db-key';
/**
 * Identity hint for the cold-start read-cache restore (DEC-01). Class
 * `account-metadata`: written when the authenticated identity resolves and
 * deleted on sign-out via `deleteAccountMetadata`.
 */
export const ACTIVE_USER_ID_KEY = 'active-user-id';
/**
 * Sign-out cleanup tombstone (Phase 2, class `safe-retry`). Records which
 * remote cleanup parts (session revoke / push unregister) failed at logout so
 * the next authenticated opportunity can reconcile them. Deliberately NOT
 * epoch-fenced and NOT deleted on sign-out: it must survive the teardown.
 */
export const LOGOUT_CLEANUP_TOMBSTONE_KEY = 'logout-cleanup-tombstone';
export const KILOCLAW_OWNED_KEY = 'kiloclaw-owned';
export const REFRESH_TOKEN_KEY = 'auth-refresh-token';
export const TOKEN_EXPIRES_AT_KEY = 'auth-token-expires-at';
export const LEGACY_EXCHANGE_DONE_KEY = 'auth-legacy-exchange-done';
/** iOS App Attest key identifier. The key itself lives in the Secure Enclave. */
export const ATTEST_KEY_ID_KEY = 'auth-attest-key-id';
/**
 * Durable mirror of the pending deep-link destination (P1-E-43b). Written
 * fire-and-forget on `setPendingDeepLink`, restored on cold start, and deleted
 * when the slot is consumed or on sign-out.
 */
export const PENDING_DEEP_LINK_KEY = 'pending-deep-link';
/**
 * Launch context for the Android image picker (P1-I-66b). Written right before
 * a camera/library launch and read by the recovery hook after an Activity
 * recreation. Deleted on sign-out: it carries a user id and a session id.
 */
export const PICKER_LAUNCH_CONTEXT_KEY = 'picker-launch-context';
/**
 * Per-user network-fallback consent for voice transcription (P1-I-68a). Not
 * deleted on sign-out — a per-user decision must survive sign-out and sign-in
 * of the same account, matching `CONSENT_USER_KEY_PREFIX`.
 */
export const VOICE_NETWORK_CONSENT_KEY_PREFIX = 'voice-network-consent-';
/**
 * Encrypted-KV scope for the durable session-attention ack store (P1-F-48a).
 * Holds one serialized blob of `{ sessionId, raiseId, status, ackedAt,
 * expiresAt }` entries; ids and timestamps only, no secrets.
 */
export const SESSION_ATTENTION_KEY = 'session-attention';

/**
 * Injective hex-encoding of a per-user storage key: reversible, alphanumeric,
 * no collisions. Shared by the analytics and voice-network consent records.
 */
export function encodeStorageKey(prefix: string, userId: string): string {
  return `${prefix}${[...new TextEncoder().encode(userId)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

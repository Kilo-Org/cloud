import * as z from 'zod';
import { utf8ByteLength } from '@/lib/utf8-utils';

/**
 * Centralized SecureStore key constants and persisted draft contracts.
 *
 * All keys used with expo-secure-store should be defined here so they stay
 * consistent across reads, writes, and sign-out cleanup.
 * Keys must not be empty and contain only alphanumeric characters, ".", "-", and "_".
 */

export const AUTH_TOKEN_KEY = 'auth-token';
/** Legacy, ownerless selection. Read only as an explicit recovery candidate; never restore it automatically. */
export const ORGANIZATION_STORAGE_KEY = 'selected-organization';
/** Account-owned tagged context records survive sign-out. Remove the legacy fallback after explicit migration. */
export const SELECTED_CONTEXT_KEY_PREFIX = 'selected-context-v1-';
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
/** Revocable per-host list of markdown link hosts that open without an Alert. */
export const TRUSTED_HOSTS_KEY = 'trusted-hosts';
export const PR_REVIEW_FOOTER_KEY = 'pr-review-footer-enabled';
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

// Legacy draft contracts remain re-exported from persist/drafts. Keep these exact serialized forms
// until every producer adopts tagged keys and explicit recovery finishes; never rewrite them on read.
const stringDraftSchema = z.string();
export function isStringDraft(value: unknown): value is string {
  return stringDraftSchema.safeParse(value).success;
}
export function agentComposerDraftKey(sessionId: string): string {
  return `agent-composer:${sessionId}`;
}
export const NEW_SESSION_DRAFT_KEY = 'agent-composer:new';
export const SHARE_PAYLOADS_DRAFT_KEY = 'share-payloads';
export const SHARE_NAV_DRAFT_KEY = 'share-navigation';
export const PENDING_SHARE_ID_DRAFT_KEY = 'pending-share-id';
export const SESSION_SEARCH_DRAFT_KEY = 'session-search-query';
export function prReviewDraftKey(owner: string, repo: string, number: number): string {
  return `pr-review:${owner}/${repo}#${number}`;
}
export function prMergeDraftKey(owner: string, repo: string, number: number): string {
  return `pr-merge:${owner}/${repo}#${number}`;
}
// eslint-disable-next-line max-params -- retain the legacy PR/comment key API
export function prReplyDraftKey(
  owner: string,
  repo: string,
  number: number,
  commentId: number
): string {
  return `pr-reply:${owner}/${repo}#${number}:${commentId}`;
}
// eslint-disable-next-line max-params -- retain the legacy diff-position key API
export function prCommentDraftKey(
  owner: string,
  repo: string,
  number: number,
  path: string,
  side: string,
  line: number,
  startLine?: number
): string {
  return `pr-comment:${owner}/${repo}#${number}:${path}:${side}:${startLine ?? line}-${line}`;
}
const mergeDraftSchema = z.object({ title: z.string(), message: z.string() });
export function isMergeDraft(value: unknown): value is { title: string; message: string } {
  return mergeDraftSchema.safeParse(value).success;
}
const sharePayloadsDraftSchema = z.object({
  order: z.array(z.string()),
  entries: z.record(
    z.string(),
    z.object({
      text: z.string(),
      files: z.array(z.object({ name: z.string(), uri: z.string() })),
      failedFiles: z.array(z.string()),
    })
  ),
});
export type SharePayloadsDraft = z.infer<typeof sharePayloadsDraftSchema>;
export function isSharePayloadsDraft(value: unknown): value is SharePayloadsDraft {
  return sharePayloadsDraftSchema.safeParse(value).success;
}
const shareNavigationDraftSchema = z.array(
  z.object({ href: z.string(), shareId: z.string().nullable() })
);
export type ShareNavigationDraft = z.infer<typeof shareNavigationDraftSchema>;
export function isShareNavigationDraft(value: unknown): value is ShareNavigationDraft {
  return shareNavigationDraftSchema.safeParse(value).success;
}
export function securityDismissDraftKey(scope: string, findingId: string): string {
  return `security-dismiss:${scope}:${findingId}`;
}
export function resolvePrefillOverDraft(
  prefillText: string | null | undefined,
  draftText: string | null | undefined
): string | undefined {
  return prefillText != null && prefillText.trim().length > 0
    ? prefillText
    : (draftText ?? undefined);
}

/** Serialize stored values without scheduling a write for unsupported or oversized data. */
export function serializeStoredDraft(
  value: unknown,
  maxBytes: number,
  onFailure: (error: unknown, fingerprint?: string) => void
): string | null {
  try {
    // JSON.stringify's declared return omits unsupported top-level values such as undefined.
    const serialized = JSON.stringify(value) as string | undefined;
    if (serialized === undefined) {
      onFailure(
        new Error('draft value cannot be serialized to JSON'),
        'draft-write-unsupported-value'
      );
      return null;
    }
    return utf8ByteLength(serialized) <= maxBytes ? serialized : null;
  } catch (error) {
    onFailure(error);
    return null;
  }
}

/** Validate unknown stored bytes without disclosing their contents in an error message. */
export function parseStoredDraft<T>(
  raw: string,
  isValid: (value: unknown) => value is T,
  maxBytes: number
):
  | Readonly<{ status: 'present'; value: T; serialized: string }>
  | Readonly<{ status: 'malformed'; reason: 'size' | 'shape' | 'json' }> {
  if (utf8ByteLength(raw) > maxBytes) {
    return { status: 'malformed', reason: 'size' };
  }
  try {
    const value: unknown = JSON.parse(raw);
    return isValid(value)
      ? { status: 'present', value, serialized: raw }
      : { status: 'malformed', reason: 'shape' };
  } catch {
    return { status: 'malformed', reason: 'json' };
  }
}

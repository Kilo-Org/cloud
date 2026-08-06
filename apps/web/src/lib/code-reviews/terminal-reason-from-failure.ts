/**
 * Maps the structured failure cloud-agent-next already sends on the code review
 * status callback onto a `CodeReviewTerminalReason`.
 *
 * cloud-agent-next classifies every terminal failure into a
 * `CloudAgentSafeFailure` ({ stage, code, subtype, attempts, message }) and puts
 * it on the callback payload. Historically the receiver read `failure.code` for
 * exactly one case (workspace_setup_failed + sandbox_storage_full) and ignored
 * the rest, so ~26% of failures were stored with a NULL terminal_reason and a
 * human-readable sentence in error_message. The admin error analysis then tried
 * to recover the category by pattern-matching that sentence, and everything it
 * missed collapsed into "Other".
 *
 * This module consumes the structured value instead, so classification no longer
 * round-trips through English.
 */

import type {
  CloudAgentAssistantFailureReason,
  CloudAgentFailureCode,
  CloudAgentProviderOwnership,
  CloudAgentSafeFailure,
  WorkspaceFailureSubtype,
} from '@kilocode/worker-utils/cloud-agent-failure';
import type { CodeReviewTerminalReason } from '@kilocode/db/schema-types';

/**
 * Workspace failures carry a subtype that is strictly more specific than the
 * `workspace_setup_failed` code, so it is consulted first.
 */
const WORKSPACE_SUBTYPE_REASONS = {
  sandbox_storage_full: 'workspace_capacity',
  git_clone_timeout: 'repository_clone_failed',
  git_checkout_timeout: 'repository_clone_failed',
  git_rate_limited: 'repository_clone_failed',
  git_network_failed: 'repository_clone_failed',
  git_authentication_failed: 'repository_auth_failed',
  git_pack_corrupt: 'repository_checkout_failed',
  git_checkout_conflict: 'repository_checkout_failed',
  git_branch_missing: 'repository_checkout_failed',
  kilo_import_timeout: 'session_import_failed',
  kilo_import_failed: 'session_import_failed',
  setup_command_timeout: 'setup_command_failed',
  setup_command_failed: 'setup_command_failed',
  workspace_setup_unknown: 'workspace_setup_failed',
} as const satisfies Record<WorkspaceFailureSubtype, CodeReviewTerminalReason>;

/**
 * Every `CloudAgentFailureCode` maps to a reason. `satisfies Record<...>` makes
 * this exhaustive: adding a code upstream without deciding its category here is
 * a type error rather than a silent slide into "Other".
 */
const FAILURE_CODE_REASONS = {
  sandbox_connect_failed: 'sandbox_connection',
  workspace_setup_failed: 'workspace_setup_failed',
  kilo_server_failed: 'runtime_startup_failed',
  wrapper_start_failed: 'runtime_startup_failed',
  invalid_delivery_request: 'delivery_failed',
  session_metadata_missing: 'delivery_failed',
  delivery_failure_unknown: 'delivery_failed',
  model_missing: 'model_not_found',
  wrapper_disconnected: 'wrapper_failed',
  wrapper_no_output: 'wrapper_failed',
  wrapper_ping_timeout: 'wrapper_failed',
  wrapper_error_before_activity: 'wrapper_failed',
  wrapper_error_after_activity: 'wrapper_failed',
  assistant_error: 'assistant_failed',
  missing_assistant_reply: 'assistant_no_reply',
  payment_required: 'billing',
  user_interrupt: 'user_cancelled',
  container_shutdown: 'container_shutdown',
  system_interrupt: 'interrupted',
  unclassified: 'unknown',
} as const satisfies Record<CloudAgentFailureCode, CodeReviewTerminalReason>;

/**
 * `assistant_error` is a single code covering every provider-side failure, so on
 * its own it would collapse rate limiting (by far the largest bucket) into one
 * undifferentiated category.
 *
 * cloud-agent-next now reports the finer reason structurally on
 * `failure.assistantReason`, so this is an enum-to-enum map with no text
 * matching. `satisfies Record<...>` keeps it exhaustive: a new assistant reason
 * upstream is a type error here rather than a silent fall back to generic.
 */
const ASSISTANT_REASON_REASONS = {
  rate_limited: 'assistant_rate_limited',
  provider_unavailable: 'assistant_unavailable',
  timeout: 'assistant_timeout',
  provider_authentication: 'assistant_unauthorized',
  invalid_request: 'assistant_invalid_request',
  insufficient_credits: 'billing',
  model_unavailable: 'model_not_found',
  unknown: 'assistant_failed',
} as const satisfies Record<CloudAgentAssistantFailureReason, CodeReviewTerminalReason>;

/**
 * Rate limiting split by whose key was throttled. A customer's own key hitting
 * its quota is not actionable for us; our managed key hitting ours is.
 * Unknown ownership keeps the unqualified reason.
 */
const RATE_LIMITED_BY_OWNERSHIP = {
  byok: 'assistant_rate_limited_byok',
  managed: 'assistant_rate_limited_managed',
  unknown: 'assistant_rate_limited',
} as const satisfies Record<CloudAgentProviderOwnership, CodeReviewTerminalReason>;

/**
 * Fallback for payloads sent before cloud-agent-next reported `assistantReason`.
 *
 * These are exact, whole-string matches against the constants produced by
 * `classifyAssistantFailure`, not substring heuristics. Retained only so that
 * in-flight callbacks from an older sender still classify; new payloads take the
 * structured path above and never reach this.
 *
 * A Map rather than an object literal: the key is caller-supplied free text (the
 * schema bounds only its length), and an object lookup for 'constructor' or
 * '__proto__' would resolve an inherited Object.prototype member. That value is
 * truthy, so it would defeat the fallback and write a function reference into
 * the terminal_reason column. Map keys have no prototype chain.
 */
const ASSISTANT_MESSAGE_REASONS = new Map<string, CodeReviewTerminalReason>([
  ['Assistant request was rate limited', 'assistant_rate_limited'],
  ['Assistant service is unavailable', 'assistant_unavailable'],
  ['Assistant request timed out', 'assistant_timeout'],
  ['Assistant request was not authorized', 'assistant_unauthorized'],
  ['Assistant request was invalid', 'assistant_invalid_request'],
]);

/**
 * Resolve a terminal reason from the structured callback failure.
 *
 * Returns undefined when there is no structured failure, or when the code is
 * `unclassified` — in that case the caller's existing message-based inference
 * still gets a chance rather than being pre-empted by a useless 'unknown'.
 */
export function terminalReasonFromCloudAgentFailure(
  failure: CloudAgentSafeFailure | undefined,
  errorMessage?: string
): CodeReviewTerminalReason | undefined {
  if (!failure?.code) return undefined;

  if (failure.code === 'workspace_setup_failed' && failure.subtype) {
    return WORKSPACE_SUBTYPE_REASONS[failure.subtype];
  }

  if (failure.code === 'assistant_error') {
    // Structured reason wins. Rate limiting refines further by whose key was
    // throttled, which is the difference between an actionable failure and one
    // only the customer can resolve.
    if (failure.assistantReason) {
      return failure.assistantReason === 'rate_limited'
        ? RATE_LIMITED_BY_OWNERSHIP[failure.providerOwnership ?? 'unknown']
        : ASSISTANT_REASON_REASONS[failure.assistantReason];
    }

    // Older payloads carry only the flattened text.
    const message = (failure.message ?? errorMessage)?.trim();
    return (message ? ASSISTANT_MESSAGE_REASONS.get(message) : undefined) ?? 'assistant_failed';
  }

  const reason = FAILURE_CODE_REASONS[failure.code];
  return reason === 'unknown' ? undefined : reason;
}

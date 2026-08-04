/**
 * Customer-facing copy for terminal reasons that need something friendlier than
 * the raw `error_message`.
 *
 * Deliberately narrow. Most failures either have nothing useful to say to the
 * customer or are already handled by the action-required path, which owns its
 * own copy AND disables Code Reviewer. This map is the opposite: it is
 * notification only and changes no behaviour.
 *
 * A reason belongs here only when we can state the cause accurately. Notably
 * `assistant_rate_limited_managed` is absent: it means the request used Kilo's
 * provider credentials, which currently conflates our upstream quota running out
 * with our own abuse rules throttling the request. Those mean different things
 * to a customer, so until they can be told apart it keeps the generic message
 * rather than getting a sentence that would be wrong half the time.
 */

import type { CodeReviewTerminalReason } from '@kilocode/db/schema-types';

export type CodeReviewTerminalReasonCopy = {
  /** Replaces the default "Error" label in the app. */
  label: string;
  /** Shown in place of the raw error_message. */
  message: string;
  /** GitHub check run title. Kept short; GitHub truncates aggressively. */
  checkTitle: string;
  /** GitHub check run summary and the GitLab commit status description. */
  checkSummary: string;
  /**
   * Markdown written into the PR summary comment in place of a review, so the
   * run's outcome is recorded in the thread rather than only in the checks tab.
   *
   * MUST start with the `<!-- kilo-review -->` marker: that is how the summary
   * comment is located for update, and writing a body without it would orphan
   * the existing comment and create a duplicate on the next run.
   *
   * Because this is published to the pull request, which may be a public
   * repository, it must never interpolate a raw `error_message`. Each entry is
   * a deliberate, reviewed sentence.
   */
  summaryBody: string;
};

/** Identifies the Kilo summary comment for in-place updates. */
const KILO_REVIEW_MARKER = '<!-- kilo-review -->';

/**
 * A Map rather than an object literal. Callers pass the raw `terminal_reason`
 * column, so a value of 'constructor' or '__proto__' would resolve an inherited
 * Object.prototype member on an object literal. That value is truthy, defeating
 * the null fallback and returning a function where copy is expected. Map keys
 * have no prototype chain.
 */
const COPY_BY_TERMINAL_REASON = new Map<CodeReviewTerminalReason, CodeReviewTerminalReasonCopy>([
  [
    'assistant_rate_limited_byok',
    {
      label: 'Rate limited',
      message: 'Your provider API key hit its rate limit.',
      checkTitle: 'Kilo Code Review rate limited',
      checkSummary: 'Your provider API key hit its rate limit.',
      summaryBody: `${KILO_REVIEW_MARKER}
## Code Review Summary

**This review did not run.** Your provider API key hit its rate limit, so the
request was rejected before the review started. Kilo does not retry
automatically, because the quota is your provider's; push a new commit once it
resets. Any inline comments below are from an earlier review.`,
    },
  ],
]);

/**
 * Resolve customer-facing copy for a terminal reason, or null when the raw
 * error message should be shown as-is.
 *
 * Accepts the loose `string | null` the DB column and UI props carry, so callers
 * do not have to narrow before asking.
 */
export function getCodeReviewTerminalReasonCopy(
  terminalReason: string | null | undefined
): CodeReviewTerminalReasonCopy | null {
  if (!terminalReason) return null;
  return COPY_BY_TERMINAL_REASON.get(terminalReason as CodeReviewTerminalReason) ?? null;
}

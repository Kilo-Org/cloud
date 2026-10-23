// Pure helpers for the review-detail screen. Kept dependency-free so they can be
// unit-tested without mounting the screen or importing React Native / tRPC.

import { i18n } from '@/i18n';
import { ACTION_REQUIRED_KEYS } from '@/components/code-reviewer/action-required-keys';

export function reviewFailureLabel(
  t: typeof i18n.t,
  errorMessage: string | null,
  terminalReason?: string | null
): string {
  if (
    terminalReason === 'github_installation_required' ||
    terminalReason === 'github_ip_allow_list' ||
    terminalReason === 'gitlab_project_access_required' ||
    terminalReason === 'byok_invalid_key' ||
    terminalReason === 'selected_model_unavailable' ||
    terminalReason === 'repeated_repository_clone_timeout'
  ) {
    return t(ACTION_REQUIRED_KEYS[terminalReason].description);
  }
  if (
    errorMessage ===
    'Dispatch failed: could not reach the code review service. ' +
      'It may be offline — retry the review once it is running.'
  ) {
    return t('codeReviewer.reviewDetail.serviceUnavailable');
  }
  return t('codeReviewer.reviewDetail.reviewFailed');
}

// The cancellation paths store a short internal diagnostic in `error_message`.
// Both the SQL in apps/web/src/lib/code-reviews/db/code-reviews.ts and the
// worker client's cancel reasons keep writing those phrases, so the screen maps
// them to a sentence that explains the outcome instead of echoing the phrase.
const INTEGRATION_DISCONNECTED_MESSAGE = 'Platform integration disconnected';

const CANCELLATION_REASON_KEYS = new Map<string, string>([
  // A Map, not an object literal: the key is the raw `error_message` column, so
  // an inherited member such as `constructor` would resolve truthy and defeat
  // the lookup. terminal-reason-copy.ts uses the same shape for the same reason.
  [
    'Bitbucket Code Reviewer disabled',
    'codeReviewer.reviewDetail.cancelReasonBitbucketReviewerDisabled',
  ],
  [
    'Bitbucket pull request state superseded this review',
    'codeReviewer.reviewDetail.cancelReasonBitbucketPullRequestChanged',
  ],
]);

/**
 * Localized explanation for a review that ended cancelled or interrupted, or
 * null when the row carries no stored message to explain. Every message gets
 * copy: the causes the row can tell apart say so, and the rest fall back to a
 * sentence that names the outcome without inventing a cause.
 */
export function reviewCancellationLabel(
  t: typeof i18n.t,
  args: {
    status: string;
    errorMessage: string | null;
    terminalReason?: string | null;
    platformLabel: string;
  }
): string | null {
  if (args.status !== 'cancelled' && args.status !== 'interrupted') {
    return null;
  }
  if (!args.errorMessage) {
    return null;
  }
  if (args.errorMessage === INTEGRATION_DISCONNECTED_MESSAGE) {
    return t('codeReviewer.reviewDetail.cancelReasonIntegrationDisconnected', {
      platform: args.platformLabel,
    });
  }
  const reasonKey = CANCELLATION_REASON_KEYS.get(args.errorMessage);
  if (reasonKey) {
    return t(reasonKey);
  }
  if (args.terminalReason === 'superseded' || args.errorMessage.startsWith('Superseded by ')) {
    return t('codeReviewer.reviewDetail.cancelReasonSuperseded');
  }
  return t(
    args.status === 'cancelled'
      ? 'codeReviewer.reviewDetail.cancelReasonCancelled'
      : 'codeReviewer.reviewDetail.cancelReasonInterrupted'
  );
}

export function gateThresholdLabel(threshold: string): string {
  switch (threshold) {
    case 'off': {
      return i18n.t('codeReviewer.gate.off');
    }
    case 'all': {
      return i18n.t('codeReviewer.gate.all');
    }
    case 'critical': {
      return i18n.t('codeReviewer.gate.critical');
    }
    case 'warning': {
      return i18n.t('codeReviewer.gate.warning');
    }
    default: {
      return i18n.t('common.unknown');
    }
  }
}

// Flatten the persisted council result into a single finding list. The council
// result stores findings per specialist; the detail screen renders them as one
// flat, paginated list. A null/absent council result (standard review, or a
// council run that has not reached a terminal state) yields no findings.
export function flattenCouncilFindings<F>(
  councilResult: { specialists: { findings: F[] }[] } | null | undefined
): F[] {
  if (!councilResult) {
    return [];
  }
  return councilResult.specialists.flatMap(specialist => specialist.findings);
}

// Human label for the code-owned aggregate decision. Null means the council ran
// in `advisory` mode and computed no verdict.
export function councilDecisionLabel(decision: 'pass' | 'block' | null | undefined): string {
  if (decision === 'pass') {
    return i18n.t('codeReviewer.decision.pass');
  }
  if (decision === 'block') {
    return i18n.t('codeReviewer.decision.block');
  }
  return i18n.t('codeReviewer.decision.noDecision');
}

// Human label for one specialist's binary vote. Null means the specialist
// returned no reliable result (not a `block`).
export function councilVoteLabel(vote: 'pass' | 'block' | null | undefined): string {
  if (vote === 'pass') {
    return i18n.t('codeReviewer.decision.pass');
  }
  if (vote === 'block') {
    return i18n.t('codeReviewer.decision.block');
  }
  return i18n.t('codeReviewer.decision.noResult');
}

// The retry control for a terminal review. The server rejects a retry of an
// automatic review (no `manual_config`) while Code Reviewer is off or its
// configuration needs attention, so the screen links to the settings instead.
// Null hides both while the config loads. An unknown config (no query, or a
// failed one) keeps Retry, because the server is the authority.
export function selectRetryAction(args: {
  hasManualConfig: boolean;
  configPending: boolean;
  config: { isEnabled: boolean; actionRequired: unknown } | undefined;
}): 'retry' | 'fix-settings' | null {
  if (args.hasManualConfig) {
    return 'retry';
  }
  if (args.configPending) {
    return null;
  }
  if (args.config === undefined) {
    return 'retry';
  }
  return args.config.isEnabled && args.config.actionRequired == null ? 'retry' : 'fix-settings';
}

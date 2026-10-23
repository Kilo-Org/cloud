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

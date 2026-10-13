// Pure helpers for the review-detail screen. Kept dependency-free so they can be
// unit-tested without mounting the screen or importing React Native / tRPC.

import { i18n } from '@/i18n';

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

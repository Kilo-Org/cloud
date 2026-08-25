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

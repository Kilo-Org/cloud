import { decodePercentEncodedSegments } from '@kilocode/app-shared/percent-encoded-segments';

/**
 * The branch label the session row, the shared-session page and the indexed
 * search document show.
 *
 * A session stores its branch percent-encoded (`fix/%E8%AB%8B%E6%B1%82%E6%9B%B8`),
 * while the name people read is the decoded one, so the branch decodes with the
 * same rule the repository label uses. A branch that is absent or empty has no
 * label.
 */
export function sessionBranchLabel(branch: string | null | undefined): string | null {
  if (branch == null || branch === '') {
    return null;
  }
  return decodePercentEncodedSegments(branch);
}

/**
 * Compose the provenance subtitle for a session row from the branch label the
 * caller already decoded.
 *
 * The caller passes `sessionBranchLabel`'s output, so one decode serves the
 * visible subtitle, the card subtitle and the spoken label, and the visible and
 * the spoken text can never name different branches. This function only joins;
 * it never decodes again.
 *
 *   - label and PR number → `"<label> · #N"`
 *   - label only → the label
 *   - PR number only → `"#N"`
 *   - neither → `null`
 *
 * `null` and `''` mean the row has no branch text.
 */
export function composeSessionProvenanceSubtitle(params: {
  branchLabel: string | null;
  prNumber: number | null | undefined;
}): string | null {
  const { branchLabel, prNumber } = params;
  const hasLabel = branchLabel != null && branchLabel !== '';
  const hasPr = prNumber != null;
  if (hasLabel && hasPr) {
    return `${branchLabel} · #${prNumber}`;
  }
  if (hasLabel) {
    return branchLabel;
  }
  if (hasPr) {
    return `#${prNumber}`;
  }
  return null;
}

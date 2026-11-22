/**
 * Compose the provenance subtitle for a session row from the branch label the
 * caller already decoded with `sessionBranchLabel` from
 * `@/lib/session-branch-label`.
 *
 * The caller passes that function's output, so one decode serves the visible
 * subtitle, the card subtitle and the spoken label, and the visible and the
 * spoken text can never name different branches. This function only joins; it
 * never decodes again.
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

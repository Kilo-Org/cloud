/**
 * Compose the provenance subtitle for a session row.
 *
 *   - both branch and PR number → `"branch · #N"`
 *   - branch only → the branch
 *   - PR number only → `"#N"`
 *   - neither → `null`
 */
export function composeSessionProvenanceSubtitle(params: {
  branch: string | null | undefined;
  prNumber: number | null | undefined;
}): string | null {
  const { branch, prNumber } = params;
  const hasBranch = branch != null && branch !== '';
  const hasPr = prNumber != null;
  if (hasBranch && hasPr) {
    return `${branch} · #${prNumber}`;
  }
  if (hasBranch) {
    return branch;
  }
  if (hasPr) {
    return `#${prNumber}`;
  }
  return null;
}

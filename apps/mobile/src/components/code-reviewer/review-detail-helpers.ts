// Pure helpers for the review-detail screen. Kept dependency-free so they can be
// unit-tested without mounting the screen or importing React Native / tRPC.

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
    return 'Pass';
  }
  if (decision === 'block') {
    return 'Block';
  }
  return 'No decision';
}

// Human label for one specialist's binary vote. Null means the specialist
// returned no reliable result (not a `block`).
export function councilVoteLabel(vote: 'pass' | 'block' | null | undefined): string {
  if (vote === 'pass') {
    return 'Pass';
  }
  if (vote === 'block') {
    return 'Block';
  }
  return 'No result';
}

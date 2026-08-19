/**
 * Pure copy selectors for the review-submit sheet's stale-head path. Kept
 * out of the component so the submit CTA label and the partial-result
 * message are unit-testable without mounting the sheet.
 */

export function selectSubmitCtaLabel(args: { freshCount: number; totalCount: number }): string {
  if (args.totalCount > args.freshCount) {
    return `Submit ${args.freshCount} of ${args.totalCount} comments`;
  }
  return 'Submit review';
}

export function selectPartialSubmitMessage(args: {
  freshCount: number;
  staleCount: number;
}): string | null {
  if (args.staleCount === 0) {
    return null;
  }
  return `Posted ${args.freshCount} comment(s). ${args.staleCount} comment(s) point at an older commit and stayed in your queue.`;
}

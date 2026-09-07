// GitHub-only gate for the diff list's write affordances.
//
// The comment composer and the review-submit sheet are siblings of the GitHub
// route — the provider write surfaces land with the provider write slice — so
// on a GitLab merge request or a Bitbucket pull request the whole write bar is
// withheld; offering it would push a GitHub route carrying a provider
// identity. Line selection goes with it: it exists only to feed that bar, and
// a tap would otherwise leave lines highlighted that the reader can neither
// comment on nor clear, since Clear lives in the same bar.
//
// The bar's reserved space goes with it too. Space is reserved at the bar's
// final size where a bar is drawn, and not at all where none is, so a provider
// diff does not end in a bar-sized hole.

import { useMemo } from 'react';
import { type ViewStyle } from 'react-native';

import {
  PR_DIFF_LIST_FOOTER_GAP,
  prDiffListBottomPadding,
} from '@/lib/pr-review/diff/pr-diff-list-bottom-padding';
import { type ProviderPrTriple, useProviderPrScope } from '@/lib/pr-review/provider-pr-ref';

type PrDiffWriteGate = {
  /** True only where the review write routes can actually be reached. */
  readonly canReviewInline: boolean;
  /** Content style for the diff list, reserving the bar's space where drawn. */
  readonly listContentStyle: ViewStyle;
};

/** Tap handler for the diff rows where selection has no CTA to feed. */
export const NO_LINE_TAP = (): void => undefined;

export function usePrDiffWriteGate(
  triple: ProviderPrTriple,
  barHeight: number | null
): PrDiffWriteGate {
  const canReviewInline = useProviderPrScope(triple).ref.platform === 'github';
  const paddingBottom = canReviewInline
    ? prDiffListBottomPadding(barHeight)
    : PR_DIFF_LIST_FOOTER_GAP;
  return useMemo(
    () => ({ canReviewInline, listContentStyle: { paddingBottom } }),
    [canReviewInline, paddingBottom]
  );
}

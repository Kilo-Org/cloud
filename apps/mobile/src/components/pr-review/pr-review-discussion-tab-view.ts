// Pure state selector for the PR Review Discussion tab.
//
// Extracts the tab's existing branch chain (unchanged in behaviour) so the
// seven outcomes can be unit-tested. The tab renders exactly what it rendered
// before; this module only owns the decision.

export type DiscussionTabViewKind =
  | 'permission'
  | 'not-found'
  | 'reconnect'
  | 'retryable'
  | 'loading'
  | 'empty'
  | 'happy';

export function selectDiscussionTabView(args: {
  firstPageErrorState: { kind: 'permission' | 'not-found' | 'reconnect' | 'retryable' } | null;
  isPending: boolean;
  isEmpty: boolean;
}): { kind: DiscussionTabViewKind } {
  const { firstPageErrorState, isPending, isEmpty } = args;

  if (firstPageErrorState) {
    return { kind: firstPageErrorState.kind };
  }
  if (isPending) {
    return { kind: 'loading' };
  }
  if (isEmpty) {
    return { kind: 'empty' };
  }
  return { kind: 'happy' };
}

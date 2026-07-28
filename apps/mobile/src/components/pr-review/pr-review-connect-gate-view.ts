export type PrReviewGateView = 'error' | 'loading' | 'connect' | 'reconnect' | 'children';

export type SelectPrReviewGateViewInput = {
  readonly isError: boolean;
  readonly isLoading: boolean;
  readonly connected: boolean;
  readonly revoked: boolean;
};

/**
 * Pure view selector for the PR-review connect gate.
 *
 * The gate is intentionally a simple priority ladder: error → loading →
 * not-connected → children. This mirrors the original component's branch
 * order and keeps every non-happy outcome in a fixed set of header-bearing
 * states.
 */
export function selectPrReviewGateView(args: SelectPrReviewGateViewInput): PrReviewGateView {
  if (args.isError) {
    return 'error';
  }
  if (args.isLoading) {
    return 'loading';
  }
  if (!args.connected) {
    return args.revoked ? 'reconnect' : 'connect';
  }
  return 'children';
}

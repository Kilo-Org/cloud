// Pure view selector for the provider-aware PR-review connect gate (s7).
//
// Extracted so every arm's branch order is unit-tested without mounting the
// gate. The gate keeps its simple priority ladder — a terminal explanation
// outranks a failed check, which outranks a pending check, which outranks
// Connect — and every non-happy outcome lands in a fixed set of
// header-bearing states.

import { type ProviderPrPlatform } from '@kilocode/app-shared/provider-review';

export type PrReviewGateView =
  | 'error'
  | 'loading'
  | 'org-only'
  | 'connect'
  | 'reconnect'
  | 'children';

export type SelectPrReviewGateViewInput = {
  /** Which provider's connection this mount checks. */
  readonly platform: ProviderPrPlatform;
  readonly isError: boolean;
  readonly isLoading: boolean;
  readonly connected: boolean;
  /**
   * The account already has this provider connection, but it can no longer be
   * used: the credential was revoked, expired, or the stored integration is no
   * longer active. A first-time connect is the wrong answer — only
   * re-authorizing the existing connection can fix it.
   */
  readonly reconnectRequired: boolean;
  /** The selected organization, or null for the personal scope. */
  readonly organizationId: string | null;
};

/**
 * Decide the gate's view.
 *
 * Bitbucket Cloud is organization-context only (s4), so a personal scope has
 * no integration to connect and no retry that could succeed: the org-only
 * explanation is the terminal state and outranks even a failed or pending
 * check (the provider query is disabled there, and a disabled query reports
 * pending forever).
 */
export function selectPrReviewGateView(args: SelectPrReviewGateViewInput): PrReviewGateView {
  if (args.platform === 'bitbucket' && args.organizationId === null) {
    return 'org-only';
  }
  if (args.isError) {
    return 'error';
  }
  if (args.isLoading) {
    return 'loading';
  }
  if (!args.connected) {
    return args.reconnectRequired ? 'reconnect' : 'connect';
  }
  return 'children';
}

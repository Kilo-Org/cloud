// Pure view selector for the provider-aware PR-review connect gate (s7).
//
// Extracted so every arm's branch order is unit-tested without mounting the
// gate. The gate keeps its simple priority ladder — a terminal explanation
// outranks a failed check, which outranks a pending check, which outranks
// Connect — and every non-happy outcome lands in a fixed set of
// header-bearing states.

import {
  gitlabInstanceOrigin,
  type ProviderPrPlatform,
} from '@kilocode/app-shared/provider-review';

export type PrReviewGateView =
  | 'error'
  | 'loading'
  | 'org-only'
  | 'connect'
  | 'reconnect'
  | 'instance-mismatch'
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
  /**
   * The connection is active, but on a different GitLab instance than the one
   * the opened merge request lives on, so no read can succeed: the server
   * refuses a hint whose origin differs from the connected instance as
   * not-found, exactly as it refuses a deleted merge request.
   */
  readonly instanceMismatch: boolean;
  /** The selected organization, or null for the personal scope. */
  readonly organizationId: string | null;
  /**
   * False while the stored account/organization selection has not been
   * restored yet. A gate that runs a scope query before that lands answers for
   * the wrong scope first and then repaints — the personal arm's Connect
   * screen, then the organization's.
   */
  readonly organizationSelectionLoaded: boolean;
};

/** The hosts a GitLab instance mismatch is explained with. */
export type GitLabInstanceMismatch = {
  /** The instance the account's connection serves. */
  readonly connectedHost: string;
  /** The instance the opened merge request lives on. */
  readonly requestedHost: string;
};

/**
 * The instance mismatch a GitLab ref carries, or null when the connection can
 * serve it.
 *
 * The comparison is the server's own: `gitlabInstanceOrigin` folds each URL to
 * host and port, and `gitlab-authorization.ts` refuses the read when the two
 * differ. An absent hint is the account's connected instance by definition (the
 * route only carries one when the link named a host), so it never mismatches,
 * and so does a connected answer that names no URL.
 */
export function gitlabInstanceMismatch(input: {
  readonly instanceHint: string | undefined;
  readonly connectedInstanceUrl: string | undefined;
}): GitLabInstanceMismatch | null {
  const requestedHost = gitlabInstanceOrigin(input.instanceHint);
  const connectedHost = gitlabInstanceOrigin(input.connectedInstanceUrl);
  if (!requestedHost || !connectedHost || requestedHost === connectedHost) {
    return null;
  }
  return { connectedHost, requestedHost };
}

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
  // Until the stored selection is restored, `organizationId` is null for a
  // personal reader AND for one about to be restored onto an organization, so
  // every branch below would answer for the wrong scope. Wait instead: the
  // resolved scope's own read decides the view.
  if (!args.organizationSelectionLoaded) {
    return 'loading';
  }
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
  // Only a live connection can be the wrong one: an inactive or missing
  // connection has no instance to compare, so Connect or Reconnect already
  // names the remedy.
  if (args.instanceMismatch) {
    return 'instance-mismatch';
  }
  return 'children';
}

export type PrReviewConnectAction = 'connect' | 'organization-admin-only';

export type SelectPrReviewConnectActionInput = {
  /** Which provider's connection this mount checks. */
  readonly platform: Exclude<ProviderPrPlatform, 'github'>;
  /** The connect state the gate selected; only these two offer the CTA. */
  readonly view: 'connect' | 'reconnect';
  /** The selected organization, or null for the personal scope. */
  readonly organizationId: string | null;
  /**
   * Whether the caller's organization role may manage billing (`owner`,
   * `admin`, `billing_manager`), or `null` while that read is unsettled.
   */
  readonly canManageOrganizationBilling: boolean | null;
};

/**
 * Whether the gate may offer the integration-page CTA.
 *
 * The CTA opens the web integration page, and its server rules are narrower
 * for an organization than for a personal account: every Bitbucket connect
 * (`organizations.bitbucket.connect` and the Bitbucket OAuth route) and an
 * organization GitLab *re*-authorization (an integration row already exists)
 * require `ORGANIZATION_BILLING_ROLES`. A narrower role that presses the CTA
 * reaches a page that refuses it, with no action of its own — so the gate says
 * who can act instead. A first-time GitLab connect keeps member-level access
 * on the server, and a personal scope only ever acts on the caller's own
 * token, so both keep the CTA.
 *
 * An unsettled role read (`null`) keeps the CTA too: the provider procedures
 * stay server-authorized, matching the code-reviewer screens' treatment of a
 * permission that has not resolved.
 */
export function selectPrReviewConnectAction(
  args: SelectPrReviewConnectActionInput
): PrReviewConnectAction {
  if (args.organizationId === null) {
    return 'connect';
  }
  const billingRoleRequired = args.platform === 'bitbucket' || args.view === 'reconnect';
  return billingRoleRequired && args.canManageOrganizationBilling === false
    ? 'organization-admin-only'
    : 'connect';
}

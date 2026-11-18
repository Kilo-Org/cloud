/**
 * The organization a share gate's New-session commit carries.
 *
 * The gate opens in the app's selected organization, and that selection can
 * outlive the account's access to it: the stored organization survives a lost
 * membership, the gate still offers New session from its retryable state (its
 * own session list reports the failure), and the composer then starts a create
 * the server refuses with its organization-access error — a dead end whose
 * retry cannot succeed.
 *
 * The proof that the selection is unusable is the organization's own
 * org-scoped read denying access, not a membership list that merely lacks it:
 * a list that settled earlier can be stale (a membership added on the web after
 * the fetch, a cached page), and moving a session on that alone would silently
 * change its scope. Only an access denial — with a settled, successful
 * membership list to name a target — moves the commit to the account's default
 * organization (the first membership that is not the denied one, else
 * Personal). Everything else keeps the selection.
 */
export function resolveShareNewSessionOrganization(input: {
  organizationId: string | null;
  membershipIds: readonly string[] | undefined;
  membershipsSettled: boolean;
  membershipsFailed: boolean;
  selectedOrganizationAccessDenied: boolean;
}): string | null {
  const {
    organizationId,
    membershipIds,
    membershipsSettled,
    membershipsFailed,
    selectedOrganizationAccessDenied,
  } = input;
  if (organizationId === null || !selectedOrganizationAccessDenied) {
    return organizationId;
  }
  if (membershipsFailed || !membershipsSettled || membershipIds === undefined) {
    return organizationId;
  }
  return membershipIds.find(id => id !== organizationId) ?? null;
}

/**
 * The organization a share gate's New-session commit carries.
 *
 * The gate opens in the app's selected organization, and that selection can
 * outlive the account's access to it: the stored organization survives a lost
 * membership (the organization picker marks nothing for it, and the boundary
 * reports it unavailable), while the gate still offers New session from its
 * retryable state. The composer then starts a create against an organization
 * the account cannot use, and the server answers with its organization-access
 * error — a dead end whose retry cannot succeed.
 *
 * When the membership list has settled successfully and does not hold the
 * selection, commit into the account's default organization instead — the
 * first membership, else Personal — which is the same default the organization
 * provider publishes. An unsettled or failed list proves nothing, so the
 * selection is kept rather than silently moving the session.
 */
export function resolveShareNewSessionOrganization(input: {
  organizationId: string | null;
  membershipIds: readonly string[] | undefined;
  membershipsSettled: boolean;
  membershipsFailed: boolean;
}): string | null {
  const { organizationId, membershipIds, membershipsSettled, membershipsFailed } = input;
  if (
    organizationId === null ||
    membershipsFailed ||
    !membershipsSettled ||
    membershipIds === undefined
  ) {
    return organizationId;
  }
  if (membershipIds.includes(organizationId)) {
    return organizationId;
  }
  return membershipIds[0] ?? null;
}

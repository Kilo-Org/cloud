export type NewSessionOrganization = {
  organizationId: string | undefined;
  isResolved: boolean;
};

/**
 * The account a new-session screen is scoped to. The model catalog, the
 * repositories, the profiles, the attachments, the create, and the Organization
 * section all read this one value, so the account the section names is the
 * account the session is created in.
 *
 * An explicit `organizationId` in the route wins: the launcher and share
 * hand-offs name the account their payload was staged for. A Continue/clone
 * entry never inherits the active account, because a source session without an
 * organization is a personal clone even when the app is currently in one. Every
 * other entry — the tour hand-off and the launcher "New Agent" shortcut among
 * them — follows the active account, which is where the Home entry starts a
 * session too.
 */
export function resolveNewSessionOrganization(input: {
  routeOrganizationId: string | undefined;
  isCloneEntry: boolean;
  activeOrganizationId: string | null;
  isActiveResolved: boolean;
}): NewSessionOrganization {
  // An empty query value is an absent one, never a personal selection.
  if (input.routeOrganizationId) {
    return { organizationId: input.routeOrganizationId, isResolved: true };
  }
  if (input.isCloneEntry) {
    return { organizationId: undefined, isResolved: true };
  }
  return {
    organizationId: input.isActiveResolved ? (input.activeOrganizationId ?? undefined) : undefined,
    isResolved: input.isActiveResolved,
  };
}

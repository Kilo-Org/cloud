import { parseOrganizationScope } from '@/lib/cloud-agent-scope';

export type NewSessionOrganization = {
  organizationId: string | undefined;
  isResolved: boolean;
  /** The entry that decided the scope: the route, a clone entry, or the active account. */
  accountSource: 'route' | 'clone' | 'active';
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
 *
 * A route value that cannot name an organization reads as absent, so the screen
 * falls back to the active account exactly as an entry with no route
 * organization does. The server validates the organization id as a UUID, so an
 * unvalidated value would fail every org-scoped request permanently.
 */
export function resolveNewSessionOrganization(input: {
  routeOrganizationId: string | undefined;
  isCloneEntry: boolean;
  activeOrganizationId: string | null;
  isActiveResolved: boolean;
}): NewSessionOrganization {
  // An empty or non-UUID query value is an absent one, never a personal selection.
  const routeOrganizationId = parseOrganizationScope(input.routeOrganizationId);
  if (routeOrganizationId) {
    return { organizationId: routeOrganizationId, isResolved: true, accountSource: 'route' };
  }
  if (input.isCloneEntry) {
    return { organizationId: undefined, isResolved: true, accountSource: 'clone' };
  }
  return {
    organizationId: input.isActiveResolved ? (input.activeOrganizationId ?? undefined) : undefined,
    isResolved: input.isActiveResolved,
    accountSource: 'active',
  };
}

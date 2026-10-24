import { describe, expect, it } from 'vitest';

import { resolveNewSessionOrganization } from '@/components/agents/new-session-organization';

const active = (activeOrganizationId: string | null) => ({
  routeOrganizationId: undefined as string | undefined,
  isCloneEntry: false,
  activeOrganizationId,
  isActiveResolved: true,
});

describe('resolveNewSessionOrganization', () => {
  it('follows the active account when the entry carries no organization', () => {
    // The tour hand-off and the launcher shortcut land here: the Home entry
    // starts a session in the active account, so this screen must too.
    expect(resolveNewSessionOrganization(active('org-a'))).toEqual({
      organizationId: 'org-a',
      isResolved: true,
    });
    expect(resolveNewSessionOrganization(active(null))).toEqual({
      organizationId: undefined,
      isResolved: true,
    });
  });

  it('uses the route organization over the active one', () => {
    expect(
      resolveNewSessionOrganization({
        ...active('org-a'),
        routeOrganizationId: 'org-b',
      })
    ).toEqual({ organizationId: 'org-b', isResolved: true });
  });

  it('stays unresolved until the active account settles', () => {
    expect(
      resolveNewSessionOrganization({
        ...active('org-a'),
        isActiveResolved: false,
      })
    ).toEqual({ organizationId: undefined, isResolved: false });
  });

  it('never lets an active account turn a personal clone into an organization clone', () => {
    expect(
      resolveNewSessionOrganization({
        ...active('org-a'),
        isCloneEntry: true,
      })
    ).toEqual({ organizationId: undefined, isResolved: true });
  });

  it('keeps an organization clone on its source organization', () => {
    expect(
      resolveNewSessionOrganization({
        ...active('org-a'),
        isCloneEntry: true,
        routeOrganizationId: 'org-b',
      })
    ).toEqual({ organizationId: 'org-b', isResolved: true });
  });
});

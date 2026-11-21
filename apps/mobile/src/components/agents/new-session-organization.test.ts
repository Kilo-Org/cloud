import { describe, expect, it } from 'vitest';

import { resolveNewSessionOrganization } from '@/components/agents/new-session-organization';

const ORG_A = '0f8fad5b-d9cb-469f-a165-70867728950e';
const ORG_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

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
    expect(resolveNewSessionOrganization(active(ORG_A))).toEqual({
      organizationId: ORG_A,
      isResolved: true,
      accountSource: 'active',
    });
    expect(resolveNewSessionOrganization(active(null))).toEqual({
      organizationId: undefined,
      isResolved: true,
      accountSource: 'active',
    });
  });

  it('uses the route organization over the active one', () => {
    expect(
      resolveNewSessionOrganization({
        ...active(ORG_A),
        routeOrganizationId: ORG_B,
      })
    ).toEqual({ organizationId: ORG_B, isResolved: true, accountSource: 'route' });
  });

  it('uses a parsed route organization before the active account settles', () => {
    expect(
      resolveNewSessionOrganization({
        ...active(ORG_A),
        isActiveResolved: false,
        routeOrganizationId: ORG_B,
      })
    ).toEqual({ organizationId: ORG_B, isResolved: true, accountSource: 'route' });
  });

  it('stays unresolved until the active account settles', () => {
    expect(
      resolveNewSessionOrganization({
        ...active(ORG_A),
        isActiveResolved: false,
      })
    ).toEqual({ organizationId: undefined, isResolved: false, accountSource: 'active' });
  });

  it('never lets an active account turn a personal clone into an organization clone', () => {
    expect(
      resolveNewSessionOrganization({
        ...active(ORG_A),
        isCloneEntry: true,
      })
    ).toEqual({ organizationId: undefined, isResolved: true, accountSource: 'clone' });
  });

  it('keeps an organization clone on its source organization', () => {
    expect(
      resolveNewSessionOrganization({
        ...active(ORG_A),
        isCloneEntry: true,
        routeOrganizationId: ORG_B,
      })
    ).toEqual({ organizationId: ORG_B, isResolved: true, accountSource: 'route' });
  });

  it('treats an empty route organization as absent', () => {
    expect(
      resolveNewSessionOrganization({
        ...active(ORG_A),
        routeOrganizationId: '',
      })
    ).toEqual({ organizationId: ORG_A, isResolved: true, accountSource: 'active' });
  });

  it('ignores a route organization that is not an id', () => {
    // The server validates the id as a UUID: forwarding this value would fail
    // every org-scoped request, so the screen follows the active account.
    expect(
      resolveNewSessionOrganization({
        ...active(ORG_A),
        routeOrganizationId: 'org-b',
      })
    ).toEqual({ organizationId: ORG_A, isResolved: true, accountSource: 'active' });
    expect(
      resolveNewSessionOrganization({
        ...active(ORG_A),
        isActiveResolved: false,
        routeOrganizationId: 'org-b',
      })
    ).toEqual({ organizationId: undefined, isResolved: false, accountSource: 'active' });
  });

  it('ignores a route organization that is not an id on a clone entry', () => {
    expect(
      resolveNewSessionOrganization({
        ...active(ORG_A),
        isCloneEntry: true,
        routeOrganizationId: 'org-b',
      })
    ).toEqual({ organizationId: undefined, isResolved: true, accountSource: 'clone' });
  });
});

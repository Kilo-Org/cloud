import { describe, expect, it } from 'vitest';

import { isProfileScopeStale, staleProfileScopeExit } from './profile-scope-model';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

/** A screen opened under `ORG_A`, with the app still showing it. */
const openedUnderA = {
  isLoaded: true,
  activeOrganizationId: ORG_A,
  openedUnderOrganizationId: ORG_A,
};

describe('isProfileScopeStale', () => {
  it('leaves an unresolved account alone, whatever the route carries', () => {
    expect(
      isProfileScopeStale({
        isLoaded: false,
        activeOrganizationId: ORG_B,
        openedUnderOrganizationId: undefined,
        routeOrganizationId: ORG_A,
      })
    ).toBe(false);
  });

  it('keeps a profile opened under the account the app still shows', () => {
    expect(isProfileScopeStale({ ...openedUnderA, routeOrganizationId: ORG_A })).toBe(false);
  });

  it('goes stale when the account switched away from the organization the route names', () => {
    expect(
      isProfileScopeStale({
        ...openedUnderA,
        activeOrganizationId: ORG_B,
        routeOrganizationId: ORG_A,
      })
    ).toBe(true);
  });

  it('goes stale when the account switched to Personal', () => {
    expect(
      isProfileScopeStale({
        ...openedUnderA,
        activeOrganizationId: null,
        routeOrganizationId: ORG_A,
      })
    ).toBe(true);
  });

  it('keeps an organization-scoped screen opened for a scope the account never showed', () => {
    // An agent session of another organization, or the composer's explicit
    // scope: the route's organization is not the selection from the start, and
    // no switch has happened while this screen was mounted.
    expect(
      isProfileScopeStale({
        isLoaded: true,
        activeOrganizationId: ORG_A,
        openedUnderOrganizationId: ORG_A,
        routeOrganizationId: ORG_B,
      })
    ).toBe(false);
  });

  it('keeps a screen while the selection has not resolved for it yet', () => {
    expect(
      isProfileScopeStale({
        isLoaded: true,
        activeOrganizationId: ORG_B,
        openedUnderOrganizationId: undefined,
        routeOrganizationId: ORG_A,
      })
    ).toBe(false);
  });

  it('keeps a personal profile in every account, because the list shows it in every account', () => {
    expect(
      isProfileScopeStale({
        ...openedUnderA,
        activeOrganizationId: ORG_B,
        routeOrganizationId: undefined,
      })
    ).toBe(false);
    expect(
      isProfileScopeStale({
        isLoaded: true,
        activeOrganizationId: null,
        openedUnderOrganizationId: null,
        routeOrganizationId: undefined,
      })
    ).toBe(false);
  });
});

describe('staleProfileScopeExit', () => {
  const PROFILES = 'profiles/index';

  it('returns to the list it was opened from', () => {
    expect(
      staleProfileScopeExit({
        routes: [{ name: PROFILES }, { name: 'profiles/[profileId]/index' }],
        currentIndex: 1,
        profilesRouteName: PROFILES,
      })
    ).toBe('profiles-list');
  });

  it('goes back to the screen that opened a detail with no list beneath it', () => {
    expect(
      staleProfileScopeExit({
        routes: [
          { name: 'agent-chat/[session-id]' },
          { name: 'profile-management/[profileId]/index' },
        ],
        currentIndex: 1,
        profilesRouteName: 'profile-management/index',
      })
    ).toBe('back');
  });

  it('ignores a list above the stale route, which a pop towards it cannot reach', () => {
    expect(
      staleProfileScopeExit({
        routes: [
          { name: 'agent-chat/[session-id]' },
          { name: 'profile-management/[profileId]/index' },
          { name: 'profile-management/index' },
        ],
        currentIndex: 1,
        profilesRouteName: 'profile-management/index',
      })
    ).toBe('back');
  });

  it('shows the list when the stale detail has nothing beneath it', () => {
    expect(
      staleProfileScopeExit({
        routes: [{ name: 'profile-management/[profileId]/index' }],
        currentIndex: 0,
        profilesRouteName: 'profile-management/index',
      })
    ).toBe('profiles-list');
  });
});

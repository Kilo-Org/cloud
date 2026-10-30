import { describe, expect, it } from 'vitest';

import { isProfileScopeStale, staleProfileScopeExit } from './profile-scope-model';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

describe('isProfileScopeStale', () => {
  it('leaves an unresolved account alone, whatever the route carries', () => {
    expect(
      isProfileScopeStale({
        isLoaded: false,
        activeOrganizationId: ORG_B,
        routeOrganizationId: ORG_A,
      })
    ).toBe(false);
  });

  it('keeps a profile opened under the account the app shows', () => {
    expect(
      isProfileScopeStale({
        isLoaded: true,
        activeOrganizationId: ORG_A,
        routeOrganizationId: ORG_A,
      })
    ).toBe(false);
  });

  it('goes stale when the route names an organization the account is no longer', () => {
    expect(
      isProfileScopeStale({
        isLoaded: true,
        activeOrganizationId: ORG_B,
        routeOrganizationId: ORG_A,
      })
    ).toBe(true);
  });

  it('goes stale when the account switched to Personal', () => {
    expect(
      isProfileScopeStale({
        isLoaded: true,
        activeOrganizationId: null,
        routeOrganizationId: ORG_A,
      })
    ).toBe(true);
  });

  it('keeps a personal profile in every account, because the list shows it in every account', () => {
    expect(
      isProfileScopeStale({
        isLoaded: true,
        activeOrganizationId: ORG_B,
        routeOrganizationId: undefined,
      })
    ).toBe(false);
    expect(
      isProfileScopeStale({
        isLoaded: true,
        activeOrganizationId: null,
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

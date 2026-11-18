import { describe, expect, it } from 'vitest';

import { isOrganizationScopeStale, staleOrganizationScopeExit } from './organization-scope-model';

const ORG_A = 'org-a';
const ORG_B = 'org-b';

/** A screen opened under `ORG_A`, with the app still showing it. */
const openedUnderA = {
  isLoaded: true,
  activeOrganizationId: ORG_A,
  openedUnderOrganizationId: ORG_A,
  namesOwnOrganization: false,
};

describe('isOrganizationScopeStale', () => {
  it('leaves an unresolved account alone', () => {
    expect(
      isOrganizationScopeStale({
        isLoaded: false,
        activeOrganizationId: ORG_B,
        openedUnderOrganizationId: undefined,
        namesOwnOrganization: false,
      })
    ).toBe(false);
  });

  it('keeps a screen opened under the account the app still shows', () => {
    expect(isOrganizationScopeStale(openedUnderA)).toBe(false);
  });

  it('goes stale when the account switched to another organization', () => {
    expect(isOrganizationScopeStale({ ...openedUnderA, activeOrganizationId: ORG_B })).toBe(true);
  });

  it('goes stale when the account switched to Personal', () => {
    expect(isOrganizationScopeStale({ ...openedUnderA, activeOrganizationId: null })).toBe(true);
  });

  it('goes stale when a Personal-scoped screen outlives the switch to an organization', () => {
    expect(
      isOrganizationScopeStale({
        isLoaded: true,
        activeOrganizationId: ORG_A,
        openedUnderOrganizationId: null,
        namesOwnOrganization: false,
      })
    ).toBe(true);
  });

  it('keeps a route that names its own organization, which selects it itself', () => {
    // The deep-linked hub and the `?org=` credit activity write the selection
    // on mount, so the change they cause is their own scope, not a switch away.
    expect(
      isOrganizationScopeStale({
        ...openedUnderA,
        activeOrganizationId: ORG_B,
        namesOwnOrganization: true,
      })
    ).toBe(false);
  });

  it('keeps a screen while the selection has not resolved for it yet', () => {
    expect(
      isOrganizationScopeStale({
        isLoaded: true,
        activeOrganizationId: ORG_B,
        openedUnderOrganizationId: undefined,
        namesOwnOrganization: false,
      })
    ).toBe(false);
  });
});

describe('staleOrganizationScopeExit', () => {
  const HUB = 'index';

  it('returns to the hub the screen was opened from', () => {
    expect(
      staleOrganizationScopeExit({
        routes: [{ name: HUB }, { name: 'invoices' }],
        currentIndex: 1,
        hubRouteName: HUB,
      })
    ).toBe('hub');
  });

  it('returns to the hub from a sheet pushed over it', () => {
    expect(
      staleOrganizationScopeExit({
        routes: [{ name: HUB }, { name: 'invoices' }, { name: 'invite-member' }],
        currentIndex: 2,
        hubRouteName: HUB,
      })
    ).toBe('hub');
  });

  it('goes back to the screen that opened it when the hub is not beneath', () => {
    expect(
      staleOrganizationScopeExit({
        routes: [{ name: 'profiles/index' }, { name: 'invoices' }],
        currentIndex: 1,
        hubRouteName: HUB,
      })
    ).toBe('back');
  });

  it('ignores a hub above the stale route, which a pop towards it cannot reach', () => {
    expect(
      staleOrganizationScopeExit({
        routes: [{ name: 'profiles/index' }, { name: 'invoices' }, { name: HUB }],
        currentIndex: 1,
        hubRouteName: HUB,
      })
    ).toBe('back');
  });

  it('pushes the hub when the stale screen has nothing beneath it', () => {
    expect(
      staleOrganizationScopeExit({
        routes: [{ name: 'invoices' }],
        currentIndex: 0,
        hubRouteName: HUB,
      })
    ).toBe('push-hub');
  });
});

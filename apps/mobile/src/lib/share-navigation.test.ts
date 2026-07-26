import { afterEach, describe, expect, it } from 'vitest';

import {
  __resetPendingShareNavigationForTests,
  isShareNavigationTargetFocused,
  navigationContainsShareGate,
  setPendingShareNavigation,
  takePendingShareNavigation,
} from './share-navigation';

afterEach(() => {
  __resetPendingShareNavigationForTests();
});

describe('share-navigation', () => {
  it('set then take returns the entry', () => {
    setPendingShareNavigation({ href: '/(app)/agent-chat/new?shareId=a', shareId: 'a' });
    expect(takePendingShareNavigation()).toEqual({
      href: '/(app)/agent-chat/new?shareId=a',
      shareId: 'a',
    });
  });

  it('second take returns null', () => {
    setPendingShareNavigation({ href: '/(app)/agent-chat/new?shareId=a', shareId: 'a' });
    takePendingShareNavigation();
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('overwrite before take is last-write-wins', () => {
    setPendingShareNavigation({ href: '/first', shareId: 'first' });
    setPendingShareNavigation({ href: '/second', shareId: 'second' });
    expect(takePendingShareNavigation()).toEqual({ href: '/second', shareId: 'second' });
    expect(takePendingShareNavigation()).toBeNull();
  });

  it('take with nothing pending returns null', () => {
    expect(takePendingShareNavigation()).toBeNull();
  });
});

describe('isShareNavigationTargetFocused', () => {
  it('matches same-session focused via concrete pathname', () => {
    expect(
      isShareNavigationTargetFocused('/(app)/agent-chat/ses_1?shareId=x', '/agent-chat/ses_1')
    ).toBe(true);
  });

  it('is false when the session id differs', () => {
    expect(
      isShareNavigationTargetFocused('/(app)/agent-chat/ses_1?shareId=x', '/agent-chat/ses_2')
    ).toBe(false);
  });

  it('matches focused agent-chat/new', () => {
    expect(
      isShareNavigationTargetFocused('/(app)/agent-chat/new?shareId=x', '/agent-chat/new')
    ).toBe(true);
  });

  it('is false when on a different screen', () => {
    expect(isShareNavigationTargetFocused('/(app)/agent-chat/new?shareId=x', '/')).toBe(false);
  });

  it('ignores query string on the href', () => {
    expect(
      isShareNavigationTargetFocused(
        '/(app)/agent-chat/ses_1?shareId=stale&organizationId=o',
        '/agent-chat/ses_1'
      )
    ).toBe(true);
  });

  it('ignores group segments in the href', () => {
    expect(isShareNavigationTargetFocused('/(app)/agent-chat/ses_1', '/agent-chat/ses_1')).toBe(
      true
    );
  });

  it('is unaffected by a stale shareId already on the current URL path comparison', () => {
    // Pathname from usePathname has no query; predicate must not consult params.
    expect(
      isShareNavigationTargetFocused('/(app)/agent-chat/ses_1?shareId=new', '/agent-chat/ses_1')
    ).toBe(true);
  });
});

describe('navigationContainsShareGate', () => {
  it('finds share-gate nested in routes', () => {
    expect(
      navigationContainsShareGate({
        routes: [{ name: '(app)', state: { routes: [{ name: 'share-gate' }] } }],
      })
    ).toBe(true);
  });

  it('is false when the gate is absent', () => {
    expect(
      navigationContainsShareGate({
        routes: [{ name: '(app)', state: { routes: [{ name: '(tabs)' }] } }],
      })
    ).toBe(false);
  });
});

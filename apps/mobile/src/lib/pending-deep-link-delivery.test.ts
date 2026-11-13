import { describe, expect, it } from 'vitest';

import {
  isSessionDestinationHref,
  shouldDeliverPendingDeepLink,
} from './pending-deep-link-delivery';

const SESSION_HREF = '/(app)/agent-chat/ses_1';
// The pathname a screen reports for that thread: no layout groups, no query.
const SESSION_PATHNAME = '/agent-chat/ses_1';
const ACCOUNT_PATHNAME = '/(tabs)/(3_profile)/account';

describe('shouldDeliverPendingDeepLink', () => {
  it('always delivers a destination the person chose in this process', () => {
    // Away from the landing route, on an unrelated screen: a link or a
    // notification tap someone just made still opens.
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'live',
        href: SESSION_HREF,
        atLandingRoute: false,
        pathname: ACCOUNT_PATHNAME,
      })
    ).toBe(true);
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'live',
        href: SESSION_HREF,
        atLandingRoute: true,
        pathname: '/',
      })
    ).toBe(true);
  });

  it('delivers a recovered destination while the app is on its landing route', () => {
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: SESSION_HREF,
        atLandingRoute: true,
        pathname: '/',
      })
    ).toBe(true);
  });

  it('delivers a recovered destination the app is already showing', () => {
    // A cold launch restores its own base Intent: the query and the layout
    // groups do not make the same destination look like a different one.
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: '/(app)/agent-chat/ses_1?at=msg_2',
        atLandingRoute: false,
        pathname: SESSION_PATHNAME,
      })
    ).toBe(true);
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: '/(app)/(tabs)/(3_profile)/account',
        atLandingRoute: false,
        pathname: ACCOUNT_PATHNAME,
      })
    ).toBe(true);
  });

  it('drops a recovered destination once the person is on another screen', () => {
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: SESSION_HREF,
        atLandingRoute: false,
        pathname: ACCOUNT_PATHNAME,
      })
    ).toBe(false);
  });
});

describe('isSessionDestinationHref', () => {
  it('names the session route, with or without a resume anchor', () => {
    expect(isSessionDestinationHref(SESSION_HREF)).toBe(true);
    expect(isSessionDestinationHref('/(app)/agent-chat/ses_1?at=msg_2')).toBe(true);
  });

  it('refuses every other destination the slot can carry', () => {
    expect(isSessionDestinationHref('/(app)/(tabs)/(3_profile)/account')).toBe(false);
    expect(isSessionDestinationHref('/(app)/agent-chat/new')).toBe(false);
    expect(isSessionDestinationHref('/(app)/pr-review/Kilo-Org/cloud/6234')).toBe(false);
    expect(isSessionDestinationHref('/(app)/notifications')).toBe(false);
  });
});

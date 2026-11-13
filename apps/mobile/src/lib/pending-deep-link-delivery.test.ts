import { describe, expect, it } from 'vitest';

import {
  isSessionDestinationHref,
  shouldDeliverPendingDeepLink,
} from './pending-deep-link-delivery';

const SESSION_HREF = '/(app)/agent-chat/ses_1';
// The pathname the router reports for that thread: every layout group dropped,
// no query (the same form `profileScreenPath` produces).
const SESSION_PATHNAME = '/agent-chat/ses_1';
// The pathname the router reports with the account settings screen focused:
// the tab group is a layout group too, so it does not survive either.
const ACCOUNT_PATHNAME = '/account';
const ACCOUNT_HREF = '/(app)/(tabs)/(3_profile)/account';

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
    // A cold launch restores its own base Intent: the resume anchor and the
    // group segments do not make the same destination look like a different
    // one.
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: '/(app)/agent-chat/ses_1?at=msg_2',
        atLandingRoute: false,
        pathname: SESSION_PATHNAME,
      })
    ).toBe(true);
    // A tab-grouped destination: the router reports `/account` while the href
    // carries both the app group and the tab group.
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: ACCOUNT_HREF,
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
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: '/(app)/agent-chat/ses_2',
        atLandingRoute: false,
        pathname: SESSION_PATHNAME,
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
    expect(isSessionDestinationHref(ACCOUNT_HREF)).toBe(false);
    expect(isSessionDestinationHref('/(app)/agent-chat/new')).toBe(false);
    expect(isSessionDestinationHref('/(app)/agent-chat/model-picker')).toBe(false);
    expect(isSessionDestinationHref('/(app)/pr-review/Kilo-Org/cloud/6234')).toBe(false);
    expect(isSessionDestinationHref('/(app)/notifications')).toBe(false);
  });
});

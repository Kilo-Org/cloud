import { describe, expect, it } from 'vitest';

import {
  isSessionDestinationHref,
  shouldDeliverPendingDeepLink,
} from './pending-deep-link-delivery';

const SESSION_HREF = '/(app)/agent-chat/ses_1';
// The segments `useSegments` reports for that thread.
const SESSION_SEGMENTS = ['(app)', 'agent-chat', 'ses_1'];
// The segments it reports with the account settings screen focused: the app
// group, the tabs navigator, the tab the screen lives in, then the screen.
const ACCOUNT_SEGMENTS = ['(app)', '(tabs)', '(3_profile)', 'account'];
// Two different tab roots: their pathname is `/? for both, so only the tab
// segment keeps them apart.
const PROFILE_TAB_SEGMENTS = ['(app)', '(tabs)', '(3_profile)'];
const HOME_TAB_SEGMENTS = ['(app)', '(tabs)', '(0_home)'];
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
        segments: ACCOUNT_SEGMENTS,
        fromLaunchCapture: false,
      })
    ).toBe(true);
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'live',
        href: SESSION_HREF,
        atLandingRoute: true,
        segments: HOME_TAB_SEGMENTS,
        fromLaunchCapture: false,
      })
    ).toBe(true);
  });

  it('delivers the cold-launch capture at the landing route', () => {
    // The link this process was launched into: nobody has chosen a screen yet,
    // and this is the one the launch asked for.
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: SESSION_HREF,
        atLandingRoute: true,
        segments: HOME_TAB_SEGMENTS,
        fromLaunchCapture: true,
      })
    ).toBe(true);
  });

  it('drops the durable restart record at the landing route', () => {
    // Written by an earlier process and stale by construction: this launch did
    // not name it, so it must not open over Home.
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: SESSION_HREF,
        atLandingRoute: true,
        segments: HOME_TAB_SEGMENTS,
        fromLaunchCapture: false,
      })
    ).toBe(false);
  });

  it('delivers a restart record already showing at the landing route', () => {
    // The destination is the route on screen: the navigation only inserts the
    // layout anchors beneath it.
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: '/(app)/(tabs)/(0_home)',
        atLandingRoute: true,
        segments: HOME_TAB_SEGMENTS,
        fromLaunchCapture: false,
      })
    ).toBe(true);
  });

  it('delivers a recovered destination the app is already showing', () => {
    // A cold launch restores its own base Intent: the resume anchor, the layout
    // groups and the query do not make the same destination look different.
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: '/(app)/agent-chat/ses_1?at=msg_2',
        atLandingRoute: false,
        segments: SESSION_SEGMENTS,
        fromLaunchCapture: true,
      })
    ).toBe(true);
    // A destination inside a tab: the href carries both the app group and the
    // tab group, and the focused route carries the same tab segment.
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: ACCOUNT_HREF,
        atLandingRoute: false,
        segments: ACCOUNT_SEGMENTS,
        fromLaunchCapture: false,
      })
    ).toBe(true);
  });

  it('drops a recovered destination once the person is on another screen', () => {
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: SESSION_HREF,
        atLandingRoute: false,
        segments: ACCOUNT_SEGMENTS,
        fromLaunchCapture: false,
      })
    ).toBe(false);
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: '/(app)/agent-chat/ses_2',
        atLandingRoute: false,
        segments: SESSION_SEGMENTS,
        fromLaunchCapture: false,
      })
    ).toBe(false);
  });

  it('drops the cold-launch capture once the person is on another screen', () => {
    // The producer split does not weaken the rule away from the landing route:
    // the launch capture is stale by then too.
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: SESSION_HREF,
        atLandingRoute: false,
        segments: ACCOUNT_SEGMENTS,
        fromLaunchCapture: true,
      })
    ).toBe(false);
  });

  it('delivers a recovered destination already showing under a layout group', () => {
    // The focused route lists the `(edit)` layout in its segments while the
    // href that reaches the slot never carries it, because it adds no URL
    // segment.
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: '/(app)/code-reviewer/personal/github/instructions',
        atLandingRoute: false,
        segments: ['(app)', 'code-reviewer', 'personal', 'github', '(edit)', 'instructions'],
        fromLaunchCapture: false,
      })
    ).toBe(true);
  });

  it('keeps two different tabs apart', () => {
    // The pathname of both tab roots is `/`, so a comparison on it would treat
    // the Profile tab as the screen already showing.
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: '/(app)/(tabs)/(3_profile)',
        atLandingRoute: false,
        segments: HOME_TAB_SEGMENTS,
        fromLaunchCapture: false,
      })
    ).toBe(false);
    expect(
      shouldDeliverPendingDeepLink({
        arrival: 'restored',
        href: '/(app)/(tabs)/(3_profile)',
        atLandingRoute: false,
        segments: PROFILE_TAB_SEGMENTS,
        fromLaunchCapture: false,
      })
    ).toBe(true);
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

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _resetLiveActivitySwitchForTests,
  canRegisterActivityTokenKind,
  getLiveActivityEnabled,
  getNotificationPermissionGranted,
  isLiveActivityPreferenceKnown,
  setLiveActivityEnabledValue,
  setNotificationPermissionGrantedValue,
  subscribeLiveActivityEnabled,
  subscribeLiveActivityPreferenceKnown,
  subscribeNotificationPermissionGranted,
} from './live-activity-switch';

afterEach(() => {
  _resetLiveActivitySwitchForTests();
});

describe('live activity switch', () => {
  it('notifies only on a change, so a re-read cannot end a running activity', () => {
    const listener = vi.fn<() => void>();
    subscribeLiveActivityEnabled(listener);

    setLiveActivityEnabledValue(true);
    expect(listener).not.toHaveBeenCalled();

    setLiveActivityEnabledValue(false);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getLiveActivityEnabled()).toBe(false);

    setLiveActivityEnabledValue(false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops notifying an unsubscribed listener', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeLiveActivityEnabled(listener);
    unsubscribe();
    setLiveActivityEnabledValue(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('refuses the push-to-start token while the permission is still unknown', () => {
    // A fresh process has the switch on and no permission answer yet, and an
    // unknown answer counts as ungranted: the subscription would raise the
    // Live Activity prompt before the user asked for notifications.
    expect(getLiveActivityEnabled()).toBe(true);
    expect(canRegisterActivityTokenKind('ios_push_to_start')).toBe(false);
  });

  it('refuses push-to-start until a stored switch value has been read', () => {
    // The permission is granted, but the stored switch has no answer yet: the
    // default on is not consent, so the token must not reach the server.
    setNotificationPermissionGrantedValue(true);

    expect(isLiveActivityPreferenceKnown()).toBe(false);
    expect(getLiveActivityEnabled()).toBe(true);
    expect(canRegisterActivityTokenKind('ios_push_to_start')).toBe(false);
  });

  it('allows push-to-start once the stored value resolves on', () => {
    setNotificationPermissionGrantedValue(true);
    setLiveActivityEnabledValue(true);

    expect(isLiveActivityPreferenceKnown()).toBe(true);
    expect(canRegisterActivityTokenKind('ios_push_to_start')).toBe(true);
  });

  it('tells known listeners once per unknown-to-known transition', () => {
    const listener = vi.fn<() => void>();
    subscribeLiveActivityPreferenceKnown(listener);

    setLiveActivityEnabledValue(true);
    expect(listener).toHaveBeenCalledTimes(1);

    // Later values are not transitions, so nothing fires.
    setLiveActivityEnabledValue(true);
    setLiveActivityEnabledValue(false);
    expect(listener).toHaveBeenCalledTimes(1);

    _resetLiveActivitySwitchForTests();
    const afterReset = vi.fn<() => void>();
    subscribeLiveActivityPreferenceKnown(afterReset);
    setLiveActivityEnabledValue(true);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(afterReset).toHaveBeenCalledTimes(1);
  });

  it('stops telling an unsubscribed known listener', () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeLiveActivityPreferenceKnown(listener);
    unsubscribe();
    setLiveActivityEnabledValue(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('tells no value listener when only the known state resolves on', () => {
    // A first read that resolves to the default on must not end a running
    // activity: the resolved value never changed.
    const listener = vi.fn<() => void>();
    subscribeLiveActivityEnabled(listener);

    setLiveActivityEnabledValue(true);

    expect(getLiveActivityEnabled()).toBe(true);
    expect(listener).not.toHaveBeenCalled();
  });

  it('tells value listeners before known listeners when a first read resolves off', () => {
    const order: string[] = [];
    subscribeLiveActivityEnabled(() => {
      order.push('value');
    });
    subscribeLiveActivityPreferenceKnown(() => {
      order.push('known');
    });

    setLiveActivityEnabledValue(false);

    expect(order).toEqual(['value', 'known']);
  });

  it('refuses push-to-start while the switch is off, even when the permission is granted', () => {
    setNotificationPermissionGrantedValue(true);
    setLiveActivityEnabledValue(false);

    expect(canRegisterActivityTokenKind('ios_push_to_start')).toBe(false);
  });

  it('allows push-to-start once the switch is on and the permission granted', () => {
    setNotificationPermissionGrantedValue(true);
    setLiveActivityEnabledValue(true);

    expect(canRegisterActivityTokenKind('ios_push_to_start')).toBe(true);
  });

  it('allows the Android ongoing token with the switch off and the permission ungranted', () => {
    // The gate only guards iOS push-to-start: the ongoing notification is not
    // an activity start and asks for nothing.
    setLiveActivityEnabledValue(false);

    expect(getNotificationPermissionGranted()).toBe(false);
    expect(canRegisterActivityTokenKind('android_ongoing')).toBe(true);
  });

  it('notifies permission subscribers only on a change', () => {
    const listener = vi.fn<() => void>();
    subscribeNotificationPermissionGranted(listener);

    setNotificationPermissionGrantedValue(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getNotificationPermissionGranted()).toBe(true);

    setNotificationPermissionGrantedValue(true);
    expect(listener).toHaveBeenCalledTimes(1);

    setNotificationPermissionGrantedValue(false);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getNotificationPermissionGranted()).toBe(false);
  });
});

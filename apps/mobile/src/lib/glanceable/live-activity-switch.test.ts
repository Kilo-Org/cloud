import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _resetLiveActivitySwitchForTests,
  canRegisterActivityTokenKind,
  getLiveActivityEnabled,
  getNotificationPermissionGranted,
  setLiveActivityEnabledValue,
  setNotificationPermissionGrantedValue,
  subscribeLiveActivityEnabled,
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
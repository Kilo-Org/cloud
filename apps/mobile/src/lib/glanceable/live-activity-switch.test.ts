import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _resetLiveActivitySwitchForTests,
  getLiveActivityEnabled,
  setLiveActivityEnabledValue,
  subscribeLiveActivityEnabled,
} from './live-activity-switch';

afterEach(() => {
  _resetLiveActivitySwitchForTests();
});

describe('live activity switch', () => {
  it('defaults to on, which is what the app does before the disk read lands', () => {
    expect(getLiveActivityEnabled()).toBe(true);
  });

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
});

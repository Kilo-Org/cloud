import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' as string },
  iosSink: {
    publish: vi.fn(),
    endImmediate: vi.fn(),
    startOrUpdate: vi.fn(),
  },
  sweepStrayActivities: vi.fn(),
  appStateListeners: new Set<(state: string) => void>(),
  addUserInteractionListener: vi.fn((_listener: (event: unknown) => void) => ({
    remove: vi.fn(),
  })),
  handleGlanceableInteraction: vi.fn((_event: unknown) => undefined),
  // The Home Screen widget's App Intent buttons (the timeline-patch sweep) are a
  // second registration beside the Live Activity press subscription, so its
  // module is mocked here too.
  registerWidgetActionHandling: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  AppState: {
    addEventListener: (_type: string, listener: (state: string) => void) => {
      mocks.appStateListeners.add(listener);
      return { remove: () => mocks.appStateListeners.delete(listener) };
    },
  },
  PlatformColor: (name: string) => name,
}));

vi.mock('expo-widgets', () => ({
  addUserInteractionListener: mocks.addUserInteractionListener,
}));
vi.mock('./interaction', () => ({
  handleGlanceableInteraction: mocks.handleGlanceableInteraction,
}));
vi.mock('./ios-sink', () => ({
  iosSink: mocks.iosSink,
  sweepStrayActivities: mocks.sweepStrayActivities,
}));
vi.mock('./adopt-activity', () => ({ adoptPushStartedActivity: vi.fn() }));
vi.mock('./active-agents-live-activity', () => ({
  refreshActiveAgentsLiveActivityCopy: vi.fn(),
}));
vi.mock('./active-agents-widget', () => ({
  refreshActiveAgentsWidgetCopy: vi.fn(),
}));
vi.mock('./widget-actions', () => ({
  registerWidgetActionHandling: mocks.registerWidgetActionHandling,
}));
vi.mock('./widget-logo', () => ({ ensureWidgetLogo: vi.fn() }));
vi.mock('@/i18n', () => ({ i18n: { on: vi.fn(), t: (key: string) => key } }));
vi.mock('@/lib/glanceable/live-activity-switch', () => ({
  getLiveActivityEnabled: () => true,
  subscribeLiveActivityEnabled: vi.fn(),
}));

describe('glanceable-ios register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mocks.appStateListeners.clear();
    mocks.registerWidgetActionHandling.mockClear();
  });

  it('does not register the iOS sink on Android', async () => {
    mocks.platform.OS = 'android';
    vi.resetModules();
    const { getGlanceableSinks } = await import('@/lib/glanceable/sink-registry');
    await import('./register');
    expect(getGlanceableSinks()).not.toContain(mocks.iosSink);
  });

  it('registers the iOS sink on iOS', async () => {
    mocks.platform.OS = 'ios';
    vi.resetModules();
    const { getGlanceableSinks } = await import('@/lib/glanceable/sink-registry');
    await import('./register');
    expect(getGlanceableSinks()).toContain(mocks.iosSink);
  });

  it('subscribes to Live Activity presses once on iOS and forwards them', async () => {
    mocks.platform.OS = 'ios';
    vi.resetModules();
    await import('./register');

    expect(mocks.addUserInteractionListener).toHaveBeenCalledTimes(1);
    const press = { source: 'activity-1', target: 'open', timestamp: 0 };
    mocks.addUserInteractionListener.mock.calls.at(0)?.[0]?.(press);
    expect(mocks.handleGlanceableInteraction).toHaveBeenCalledWith(press);
  });

  it('subscribes the widget press handling on iOS', async () => {
    mocks.platform.OS = 'ios';
    vi.resetModules();
    await import('./register');
    expect(mocks.registerWidgetActionHandling).toHaveBeenCalledTimes(1);
  });

  it('subscribes no widget press handling on Android', async () => {
    mocks.platform.OS = 'android';
    vi.resetModules();
    await import('./register');
    expect(mocks.registerWidgetActionHandling).not.toHaveBeenCalled();
  });

  it('does not subscribe to Live Activity presses on Android', async () => {
    mocks.platform.OS = 'android';
    vi.resetModules();
    await import('./register');

    expect(mocks.addUserInteractionListener).not.toHaveBeenCalled();
    expect(mocks.handleGlanceableInteraction).not.toHaveBeenCalled();
  });

  it('routes an approve press through the one subscription, never a second flow', async () => {
    mocks.platform.OS = 'ios';
    vi.resetModules();
    await import('./register');

    // The card's Approve and the Apple Watch mirror report the same target, so
    // one listener must own it: a second registration would answer twice.
    expect(mocks.addUserInteractionListener).toHaveBeenCalledTimes(1);
    const press = { source: 'activity-1', target: 'approve', timestamp: 0 };
    mocks.addUserInteractionListener.mock.calls.at(0)?.[0]?.(press);
    expect(mocks.handleGlanceableInteraction).toHaveBeenCalledTimes(1);
    expect(mocks.handleGlanceableInteraction).toHaveBeenCalledWith(press);
  });

  it('sweeps stray activities when the app returns to the foreground', async () => {
    mocks.platform.OS = 'ios';
    vi.resetModules();
    await import('./register');

    expect(mocks.appStateListeners.size).toBe(1);
    for (const listener of mocks.appStateListeners) {
      listener('background');
    }
    expect(mocks.sweepStrayActivities).not.toHaveBeenCalled();

    for (const listener of mocks.appStateListeners) {
      listener('active');
    }
    expect(mocks.sweepStrayActivities).toHaveBeenCalledTimes(1);
  });
});

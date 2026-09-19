import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' as string },
  iosSink: {
    publish: vi.fn(),
    endImmediate: vi.fn(),
    startOrUpdate: vi.fn(),
  },
  sweepStrayActivities: vi.fn(),
  appStateListeners: new Set<(state: string) => void>(),
  // The Home Screen widget's App Intent buttons (the timeline-patch sweep) and
  // the Live Activity's Approve control are two registrations with two
  // listeners, so both modules are mocked here.
  registerWidgetActionHandling: vi.fn(),
  registerApprove: vi.fn((_approve: () => Promise<void>) => vi.fn()),
  approveFrontAgent: vi.fn().mockResolvedValue({ kind: 'approved' }),
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
vi.mock('./approve-action', () => ({
  registerGlanceableApproveAction: mocks.registerApprove,
}));
vi.mock('@/lib/glanceable/approve-front-agent', () => ({
  approveFrontAgent: mocks.approveFrontAgent,
}));
vi.mock('./widget-logo', () => ({ ensureWidgetLogo: vi.fn() }));
vi.mock('@/i18n', () => ({ i18n: { on: vi.fn(), t: (key: string) => key } }));
vi.mock('@/lib/glanceable/live-activity-switch', () => ({
  getLiveActivityEnabled: () => true,
  subscribeLiveActivityEnabled: vi.fn(),
}));

describe('glanceable-ios register', () => {
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
    expect(mocks.registerApprove).not.toHaveBeenCalled();
  });

  it('registers the iOS sink on iOS', async () => {
    mocks.platform.OS = 'ios';
    vi.resetModules();
    const { getGlanceableSinks } = await import('@/lib/glanceable/sink-registry');
    await import('./register');
    expect(getGlanceableSinks()).toContain(mocks.iosSink);
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

  it('wires the Live Activity approve press to the front-approval service', async () => {
    mocks.platform.OS = 'ios';
    vi.resetModules();
    await import('./register');
    const [approve] = mocks.registerApprove.mock.calls[0] ?? [];
    expect(approve).toBeTypeOf('function');
    await approve?.();
    expect(mocks.approveFrontAgent).toHaveBeenCalledTimes(1);
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: { OS: 'ios' as string },
  iosSink: {
    publish: vi.fn(),
    endImmediate: vi.fn(),
    startOrUpdate: vi.fn(),
  },
  addUserInteractionListener: vi.fn((_listener: (event: unknown) => void) => ({
    remove: vi.fn(),
  })),
  handleGlanceableInteraction: vi.fn((_event: unknown) => undefined),
}));

vi.mock('react-native', () => ({
  Platform: mocks.platform,
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  PlatformColor: (name: string) => name,
}));

vi.mock('expo-widgets', () => ({
  addUserInteractionListener: mocks.addUserInteractionListener,
}));
vi.mock('./interaction', () => ({
  handleGlanceableInteraction: mocks.handleGlanceableInteraction,
}));
vi.mock('./ios-sink', () => ({ iosSink: mocks.iosSink }));
vi.mock('./adopt-activity', () => ({ adoptPushStartedActivity: vi.fn() }));
vi.mock('./active-agents-live-activity', () => ({
  refreshActiveAgentsLiveActivityCopy: vi.fn(),
}));
vi.mock('./active-agents-widget', () => ({
  refreshActiveAgentsWidgetCopy: vi.fn(),
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
    vi.resetModules();
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

  it('does not subscribe to Live Activity presses on Android', async () => {
    mocks.platform.OS = 'android';
    vi.resetModules();
    await import('./register');

    expect(mocks.addUserInteractionListener).not.toHaveBeenCalled();
    expect(mocks.handleGlanceableInteraction).not.toHaveBeenCalled();
  });
});

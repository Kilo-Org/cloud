import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import NotificationsRoute from './notifications';

const useLocalSearchParamsMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', () => ({
  useLocalSearchParams: useLocalSearchParamsMock,
}));

vi.mock('@/components/notifications-screen', () => ({
  NotificationsScreen: 'NotificationsScreen',
}));

let mounted: TestRenderer.ReactTestRenderer | undefined = undefined;

function mountRoute(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(NotificationsRoute));
  });
  if (!ref.current) {
    throw new Error('route did not render');
  }
  mounted = ref.current;
  return ref.current;
}

// The test renderer types host props as `unknown`; this names the screen prop
// the route forwards to.
type ScreenProps = { settingsTarget?: string };

function screenTarget(): string | undefined {
  const screens = mountRoute().root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'NotificationsScreen'
  );
  expect(screens).toHaveLength(1);
  const props = screens[0]?.props as ScreenProps;
  return props.settingsTarget;
}

beforeEach(() => {
  useLocalSearchParamsMock.mockReset();
});

afterEach(() => {
  const renderer = mounted;
  mounted = undefined;
  if (renderer === undefined) {
    return;
  }
  act(() => {
    renderer.unmount();
  });
});

describe('NotificationsRoute settings target', () => {
  it('forwards the target a settings-search result names', () => {
    useLocalSearchParamsMock.mockReturnValue({ settingsTarget: 'notifications.device' });

    expect(screenTarget()).toBe('notifications.device');
  });

  it('opens with no target when the route has none', () => {
    useLocalSearchParamsMock.mockReturnValue({});

    expect(screenTarget()).toBeUndefined();
  });
});

import { createElement, useEffect } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AGENTS_SESSIONS_HREF } from '@/lib/agents-sessions-route';
import { useSessionRouteBack } from './session-route-back';

// React Native's BackHandler as a set of live subscriptions: a test can press
// Android Back and observe what the mounted listener does with it.
const backPress = vi.hoisted(() => {
  const listeners = new Set<() => boolean>();
  return {
    listeners,
    addEventListener: (_event: string, listener: () => boolean) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    // RN asks the most recently added listener first and stops at the first one
    // that consumes the press.
    press: () => [...listeners].toReversed().some(listener => listener()),
  };
});
const routerState = vi.hoisted(() => ({
  canGoBack: false,
  back: vi.fn(),
  dismissTo: vi.fn(),
}));

vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: (event: string, listener: () => boolean) =>
      backPress.addEventListener(event, listener),
  },
}));
// `useFocusEffect` runs its effect while the route is focused, which is the
// lifetime the listener has.
vi.mock('expo-router', () => ({
  useFocusEffect: (effect: () => undefined | (() => void)) => {
    useEffect(effect, [effect]);
  },
  useRouter: () => ({
    canGoBack: () => routerState.canGoBack,
    back: routerState.back,
    dismissTo: routerState.dismissTo,
  }),
}));

function SessionRoute(): null {
  useSessionRouteBack();
  return null;
}

function mount(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(SessionRoute));
  });
  if (!ref.current) {
    throw new Error('renderer did not mount');
  }
  return ref.current;
}

beforeEach(() => {
  backPress.listeners.clear();
  routerState.canGoBack = false;
  routerState.back.mockReset();
  routerState.dismissTo.mockReset();
});

describe('useSessionRouteBack', () => {
  it('leaves a Back with the navigator when a route sits beneath the session', () => {
    routerState.canGoBack = true;
    const renderer = mount();

    expect(backPress.press()).toBe(false);
    expect(routerState.dismissTo).not.toHaveBeenCalled();
    expect(routerState.back).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('returns to the sessions list instead of leaving the app from the only route', () => {
    // A cold open or a replace can leave the session as the stack's only
    // screen. Android's default Back then leaves the app; the header's own back
    // control falls back to the list, and system Back answers the same way.
    const renderer = mount();

    expect(backPress.press()).toBe(true);
    expect(routerState.dismissTo).toHaveBeenCalledExactlyOnceWith(AGENTS_SESSIONS_HREF);
    renderer.unmount();
  });

  it('stops answering once the route is gone', () => {
    const renderer = mount();
    renderer.unmount();

    expect(backPress.listeners.size).toBe(0);
    expect(backPress.press()).toBe(false);
  });

  it('never answers a press a surface above it consumed first', () => {
    // A sheet, an overlay or a picker in front of the session registers its own
    // listener later, so React Native asks it first. That screen owns the press,
    // and this route must not navigate out from under it: the fallback is for a
    // press the session itself owns.
    const renderer = mount();
    backPress.addEventListener('hardwareBackPress', () => true);

    expect(backPress.press()).toBe(true);
    expect(routerState.dismissTo).not.toHaveBeenCalled();
    renderer.unmount();
  });
});

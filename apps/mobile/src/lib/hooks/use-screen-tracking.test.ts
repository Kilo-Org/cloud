/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/test/render-with-providers.tsx */
/* eslint-disable import/first -- mocks must be defined before the module under test is imported */
import { createElement, type FC } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getSettledLeafRoute,
  publishSettledLeafRoute,
  resetSettledLeafRouteForTests,
  subscribeSettledLeafRoute,
} from '@/lib/route-lifecycle';
import { SCREEN_TRACKING_SETTLE_DEBOUNCE_MS } from '@/lib/hooks/screen-tracking-decision';
import { SCREEN_TRACKING_GENERATION_POLL_MS } from '@/lib/hooks/use-screen-tracking';

const mocks = vi.hoisted(() => {
  const state = {
    segments: [] as string[],
    stale: true as boolean | undefined,
    postHogReady: false,
    generation: 1,
  };
  const readyListeners = new Set<() => void>();
  const navStateListeners = new Set<() => void>();
  const navigationRef = {
    current: {
      getRootState: () => (state.stale === undefined ? undefined : { stale: state.stale }),
    },
    addListener: (_event: string, listener: () => void): (() => void) => {
      navStateListeners.add(listener);
      return () => {
        navStateListeners.delete(listener);
      };
    },
  };
  return {
    state,
    navigationRef,
    captureScreen: vi.fn<(name: string) => void>(),
    setPostHogReady(ready: boolean): void {
      state.postHogReady = ready;
      for (const listener of readyListeners) {
        listener();
      }
    },
    subscribePostHogReady(listener: () => void): () => void {
      readyListeners.add(listener);
      return () => {
        readyListeners.delete(listener);
      };
    },
    emitNavStateChange(): void {
      for (const listener of navStateListeners) {
        listener();
      }
    },
    // Renderers are never unmounted by this harness, so their subscriptions
    // persist in the listener sets across tests and would fire the shared
    // mocks (and re-capture) when a later test flips readiness or navigation.
    clearListeners(): void {
      readyListeners.clear();
      navStateListeners.clear();
    },
  };
});

vi.mock('expo-router', () => ({
  useSegments: () => mocks.state.segments,
  useNavigationContainerRef: () => mocks.navigationRef,
}));

vi.mock('@/lib/analytics/posthog', () => ({
  captureScreen: mocks.captureScreen,
  isPostHogReady: () => mocks.state.postHogReady,
  subscribeToPostHogReady: (listener: () => void) => mocks.subscribePostHogReady(listener),
}));

vi.mock('@/lib/telemetry/controller', () => ({
  allowsOptional: () => true,
  currentGeneration: () => mocks.state.generation,
}));

import { useScreenTracking } from './use-screen-tracking';

const HOME = '(app)/(tabs)/(0_home)';
const PROFILE = '(app)/(tabs)/(3_profile)';

const TestHarness: FC<{ bootstrapSettled: boolean }> = ({ bootstrapSettled }) => {
  useScreenTracking(bootstrapSettled);
  return null;
};

function mount(bootstrapSettled = true): TestRenderer.ReactTestRenderer {
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(createElement(TestHarness, { bootstrapSettled }));
  });
  // act() is synchronous; renderer is assigned inside the callback.
  return renderer as unknown as TestRenderer.ReactTestRenderer;
}

function rerender(renderer: TestRenderer.ReactTestRenderer, bootstrapSettled = true): void {
  act(() => {
    renderer.update(createElement(TestHarness, { bootstrapSettled }));
  });
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function advanceSettleWindow(): void {
  advance(SCREEN_TRACKING_SETTLE_DEBOUNCE_MS);
}

function flipPostHogReady(ready: boolean): void {
  act(() => {
    mocks.setPostHogReady(ready);
  });
}

describe('useScreenTracking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('__DEV__', false);
    mocks.state.segments = ['(app)', '(tabs)', '(0_home)'];
    mocks.state.stale = false;
    mocks.state.postHogReady = true;
    mocks.state.generation = 1;
    mocks.captureScreen.mockReset();
    resetSettledLeafRouteForTests();
  });

  afterEach(() => {
    mocks.clearListeners();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('captures the settled home leaf once after the settle window', () => {
    mount();
    advanceSettleWindow();

    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);
    expect(mocks.captureScreen).toHaveBeenCalledWith(HOME);
  });

  it('does not capture before the settle window elapses', () => {
    mount();
    advance(SCREEN_TRACKING_SETTLE_DEBOUNCE_MS - 1);

    expect(mocks.captureScreen).not.toHaveBeenCalled();
  });

  it('never captures a transient route that changes within the settle window', () => {
    const renderer = mount();
    advance(300);
    mocks.state.segments = ['(app)', '(tabs)', '(3_profile)'];
    rerender(renderer);
    advanceSettleWindow();

    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);
    expect(mocks.captureScreen).toHaveBeenCalledWith(PROFILE);
  });

  it('gives a segment change a full quiet period after a route already settled', () => {
    const renderer = mount();
    advanceSettleWindow();
    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);
    expect(getSettledLeafRoute()).toBe(HOME);

    mocks.state.segments = ['(app)', '(tabs)', '(3_profile)'];
    rerender(renderer);
    // The previous leaf's settled value must not carry over to the new route:
    // the new route needs its own full settle window before capture or publish.
    advance(SCREEN_TRACKING_SETTLE_DEBOUNCE_MS - 1);
    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);
    expect(getSettledLeafRoute()).toBe(HOME);

    advanceSettleWindow();
    expect(mocks.captureScreen).toHaveBeenCalledTimes(2);
    expect(mocks.captureScreen).toHaveBeenLastCalledWith(PROFILE);
    expect(getSettledLeafRoute()).toBe(PROFILE);
  });

  it('re-evaluates when navigation becomes ready without a manual rerender', () => {
    mocks.state.stale = true;
    mount();
    advanceSettleWindow();
    expect(mocks.captureScreen).not.toHaveBeenCalled();

    // The container's `state` event is the reactive signal: flipping the stale
    // flag alone must re-evaluate, with no component rerender.
    mocks.state.stale = false;
    act(() => {
      mocks.emitNavStateChange();
    });

    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);
    expect(mocks.captureScreen).toHaveBeenCalledWith(HOME);
  });

  it('captures the first settled leaf when PostHog becomes ready late', () => {
    mocks.state.postHogReady = false;
    mount();
    advanceSettleWindow();
    expect(mocks.captureScreen).not.toHaveBeenCalled();
    // The leaf is settled and visible even though analytics is not ready.
    expect(getSettledLeafRoute()).toBe(HOME);

    flipPostHogReady(true);

    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);
    expect(mocks.captureScreen).toHaveBeenCalledWith(HOME);
  });

  it('does not re-capture a stable leaf when readiness re-evaluates', () => {
    mount();
    advanceSettleWindow();
    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);

    flipPostHogReady(false);
    flipPostHogReady(true);

    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);
  });

  it('gives a previously settled route a fresh quiet period when revisited within the window', () => {
    const renderer = mount();
    advanceSettleWindow();
    expect(getSettledLeafRoute()).toBe(HOME);

    // Reset the signal so a premature publish on the revisit is observable.
    resetSettledLeafRouteForTests();

    // Leave HOME; the new route has not settled yet.
    mocks.state.segments = ['(app)', '(tabs)', '(3_profile)'];
    rerender(renderer);
    advance(300);

    // Return to HOME before any fresh quiet period has elapsed. HOME's old
    // settled marker must not count again: it needs its own full window before
    // it can publish or capture.
    mocks.state.segments = ['(app)', '(tabs)', '(0_home)'];
    rerender(renderer);
    advance(SCREEN_TRACKING_SETTLE_DEBOUNCE_MS - 1);
    expect(getSettledLeafRoute()).toBeNull();

    advanceSettleWindow();
    expect(getSettledLeafRoute()).toBe(HOME);
    // Same generation and screen: the capture is a duplicate.
    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);
  });

  it('does not consume the new generation dedupe slot while the ready client is stale', () => {
    mount();
    advanceSettleWindow();
    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);

    // The account switch bumps the generation while the old client is still
    // ready. `captureScreen` would silently drop the event, so the hook must
    // neither capture nor mark HOME as captured for generation 2.
    mocks.state.generation = 2;
    advance(SCREEN_TRACKING_GENERATION_POLL_MS);
    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);

    // The consent gate discards the stale client and re-inits it under
    // generation 2. The first valid new-generation capture must still occur.
    flipPostHogReady(false);
    flipPostHogReady(true);

    expect(mocks.captureScreen).toHaveBeenCalledTimes(2);
    expect(mocks.captureScreen).toHaveBeenLastCalledWith(HOME);
  });

  it('never captures the redirect-only (app) production representation', () => {
    mocks.state.segments = ['(app)'];
    mount();
    advanceSettleWindow();

    expect(mocks.captureScreen).not.toHaveBeenCalled();
  });

  it('captures real (app) leaves that are not the redirect target', () => {
    mocks.state.segments = ['(app)', 'onboarding'];
    mount();
    advanceSettleWindow();

    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);
    expect(mocks.captureScreen).toHaveBeenCalledWith('(app)/onboarding');
  });

  it('never captures KiloClaw leaves but still publishes them as settled', () => {
    mocks.state.segments = ['(app)', '(tabs)', '(1_kiloclaw)'];
    mount();
    advanceSettleWindow();

    expect(mocks.captureScreen).not.toHaveBeenCalled();
    expect(getSettledLeafRoute()).toBe('(app)/(tabs)/(1_kiloclaw)');
  });

  it('never captures while the consent bootstrap is unsettled', () => {
    const renderer = mount(false);
    advanceSettleWindow();
    expect(mocks.captureScreen).not.toHaveBeenCalled();

    rerender(renderer, true);
    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);
    expect(mocks.captureScreen).toHaveBeenCalledWith(HOME);
  });

  it('does not capture empty segments or publish an empty leaf', () => {
    mocks.state.segments = [];
    mount();
    advanceSettleWindow();

    expect(mocks.captureScreen).not.toHaveBeenCalled();
    expect(getSettledLeafRoute()).toBeNull();
  });

  it('logs each capture in dev builds', () => {
    vi.stubGlobal('__DEV__', true);
    const logSpy = vi.spyOn(console, 'log').mockReturnValue(undefined);

    mount();
    advanceSettleWindow();

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith('[screen-tracking]', HOME);
  });

  it('does not log when capture is skipped', () => {
    vi.stubGlobal('__DEV__', true);
    const logSpy = vi.spyOn(console, 'log').mockReturnValue(undefined);
    mocks.state.segments = ['(app)', '(tabs)', '(1_kiloclaw)'];

    mount();
    advanceSettleWindow();

    expect(logSpy).not.toHaveBeenCalled();
  });

  it('publishes each settled leaf to the route-lifecycle signal', () => {
    const seen: (string | null)[] = [];
    const unsubscribe = subscribeSettledLeafRoute(() => {
      seen.push(getSettledLeafRoute());
    });

    const renderer = mount();
    advanceSettleWindow();
    expect(seen).toEqual([HOME]);

    mocks.state.segments = ['(app)', '(tabs)', '(3_profile)'];
    rerender(renderer);
    advanceSettleWindow();
    expect(seen).toEqual([HOME, PROFILE]);

    unsubscribe();
  });
});

describe('route-lifecycle signal', () => {
  beforeEach(() => {
    resetSettledLeafRouteForTests();
  });

  it('exposes a read-only get/subscribe signal and dedupes identical publishes', () => {
    expect(getSettledLeafRoute()).toBeNull();

    const seen: (string | null)[] = [];
    const unsubscribe = subscribeSettledLeafRoute(() => {
      seen.push(getSettledLeafRoute());
    });

    publishSettledLeafRoute(HOME);
    publishSettledLeafRoute(HOME);
    publishSettledLeafRoute(PROFILE);

    expect(seen).toEqual([HOME, PROFILE]);

    unsubscribe();
    publishSettledLeafRoute('(app)/force-update');
    expect(getSettledLeafRoute()).toBe('(app)/force-update');
  });
});

/* eslint-disable import/first -- mocks must be defined before the module under test is imported */
import { createElement, type FC } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCREEN_TRACKING_SETTLE_DEBOUNCE_MS } from '@/lib/hooks/screen-tracking-decision';
import type * as ScreenTrackingDecisionTypes from '@/lib/hooks/screen-tracking-decision';
import {
  currentGeneration,
  resetTelemetryControllerForTests,
  setTelemetryDecision,
} from '@/lib/telemetry/controller';

const mocks = vi.hoisted(() => {
  const state = {
    segments: ['(app)', '(tabs)', '(0_home)'] as string[],
    stale: false as boolean | undefined,
    postHogReady: true,
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
    // The real decision still runs; the spy only records each evaluation.
    decide: vi.fn<(input: { accountGeneration: number }) => void>(),
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

vi.mock('@/lib/hooks/screen-tracking-decision', async importOriginal => {
  const actual = await importOriginal<typeof ScreenTrackingDecisionTypes>();
  return {
    ...actual,
    decideScreenTracking: (input: Parameters<typeof actual.decideScreenTracking>[0]) => {
      mocks.decide(input);
      return actual.decideScreenTracking(input);
    },
  };
});

import { useScreenTracking } from './use-screen-tracking';

const HOME = '(app)/(tabs)/(0_home)';

const TestHarness: FC<{ bootstrapSettled: boolean }> = ({ bootstrapSettled }) => {
  useScreenTracking(bootstrapSettled);
  return null;
};

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

function mount(): TestRenderer.ReactTestRenderer {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  act(() => {
    rendererRef.current = TestRenderer.create(
      createElement(TestHarness, { bootstrapSettled: true })
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedRenderers.push(renderer);
  return renderer;
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

function flipPostHogReady(ready: boolean): void {
  act(() => {
    mocks.setPostHogReady(ready);
  });
}

describe('useScreenTracking generation subscription', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('__DEV__', false);
    resetTelemetryControllerForTests();
    mocks.state.segments = ['(app)', '(tabs)', '(0_home)'];
    mocks.state.stale = false;
    mocks.state.postHogReady = true;
    mocks.captureScreen.mockReset();
    mocks.decide.mockReset();
  });

  afterEach(() => {
    act(() => {
      for (const renderer of mountedRenderers) {
        renderer.unmount();
      }
    });
    mountedRenderers.length = 0;
    mocks.clearListeners();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('re-evaluates the capture decision on an account change with no timer', () => {
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    setTelemetryDecision('acct-1', true);
    mount();
    advance(SCREEN_TRACKING_SETTLE_DEBOUNCE_MS);

    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);
    expect(mocks.captureScreen).toHaveBeenCalledWith(HOME);
    const evaluationsBefore = mocks.decide.mock.calls.length;
    expect(evaluationsBefore).toBeGreaterThan(0);

    // The controller's notification, not a timer tick, drives the re-render:
    // no timer is advanced between the old and the new generation.
    act(() => {
      setTelemetryDecision('acct-2', true);
    });

    expect(mocks.decide.mock.calls.length).toBeGreaterThan(evaluationsBefore);
    expect(currentGeneration()).toBe(1);
    expect(mocks.decide.mock.calls.at(-1)?.[0].accountGeneration).toBe(currentGeneration());

    // The ready client still belongs to account 1, so this evaluation must not
    // capture under account 2: `captureScreen` would drop it and the dedupe
    // slot for account 2 would be consumed.
    expect(mocks.captureScreen).toHaveBeenCalledTimes(1);

    // Once the consent gate re-inits the client for the new generation, the
    // first valid capture lands. Still no timer has been advanced.
    flipPostHogReady(false);
    flipPostHogReady(true);

    expect(mocks.captureScreen).toHaveBeenCalledTimes(2);
    expect(mocks.captureScreen).toHaveBeenLastCalledWith(HOME);

    // The polling interval this hook used to own is gone.
    expect(intervalSpy).not.toHaveBeenCalled();
  });

  it('does not re-evaluate on a repeated decision for the same account', () => {
    setTelemetryDecision('acct-1', true);
    mount();
    advance(SCREEN_TRACKING_SETTLE_DEBOUNCE_MS);
    act(() => {
      setTelemetryDecision('acct-2', true);
    });
    const evaluationsBefore = mocks.decide.mock.calls.length;

    // A repeated decision for the same account advances only the epoch, which
    // scopes nothing to an account, so no subscriber may wake.
    act(() => {
      setTelemetryDecision('acct-2', false);
    });

    expect(mocks.decide.mock.calls.length).toBe(evaluationsBefore);
  });
});

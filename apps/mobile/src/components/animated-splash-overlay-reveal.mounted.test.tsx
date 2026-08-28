/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as animated-splash-overlay.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AnimatedSplashOverlay } from './animated-splash-overlay';

type FrameInfo = { timeSincePreviousFrame: number | null };

// `withSequence` is used once, by the reveal, so counting it proves exactly
// when the reveal ran.
const reanimated = vi.hoisted(() => ({
  sequences: 0,
  frame: undefined as ((info: FrameInfo) => void) | undefined,
  active: false,
}));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useSharedValue: (initial: unknown) => ({ value: initial }),
  useAnimatedStyle: () => ({}),
  useFrameCallback: (onFrame: (info: FrameInfo) => void) => {
    reanimated.frame = onFrame;
    return {
      setActive: (next: boolean) => {
        reanimated.active = next;
      },
    };
  },
  useReducedMotion: () => false,
  withTiming: (value: unknown) => value,
  withDelay: (_delay: number, value: unknown) => value,
  withSequence: (...values: unknown[]) => {
    reanimated.sequences += 1;
    return values.at(-1);
  },
  makeMutable: (value: unknown) => ({ value }),
  Easing: { out: (v: unknown) => v, in: (v: unknown) => v, quad: 0, cubic: 0 },
}));
vi.mock('react-native-worklets', () => ({ scheduleOnRN: vi.fn() }));
vi.mock('expo-splash-screen', () => ({
  hideAsync: vi.fn().mockResolvedValue(undefined),
  preventAutoHideAsync: vi.fn(),
}));
vi.mock('@sentry/react-native', () => ({ TimeToFullDisplay: () => null }));
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
vi.mock('@/../assets/images/logo.png', () => ({ default: 1 }));

// Owned by the test so each case starts from an incomplete launch.
const startup = vi.hoisted(() => ({ complete: false, listeners: new Set<() => void>() }));
vi.mock('@/lib/startup-timing', () => ({
  isStartupComplete: () => startup.complete,
  subscribeStartupComplete: (listener: () => void) => {
    startup.listeners.add(listener);
    return () => {
      startup.listeners.delete(listener);
    };
  },
}));

function markStartupComplete(): void {
  startup.complete = true;
  for (const listener of startup.listeners) {
    listener();
  }
}

async function mountAndReachHandover(): Promise<TestRenderer.ReactTestRenderer> {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  await act(async () => {
    await Promise.resolve();
    ref.current = TestRenderer.create(createElement(AnimatedSplashOverlay));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  const image = renderer.root.findAll(
    node => typeof node.type === 'string' && (node.type as string) === 'Image'
  )[0];
  if (!image) {
    throw new Error('expected one Image host');
  }
  act(() => {
    (image.props.onLoad as () => void)();
  });
  act(() => {
    markStartupComplete();
  });
  await act(async () => {
    await Promise.resolve();
  });
  return renderer;
}

describe('AnimatedSplashOverlay reveal start', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    startup.complete = false;
    startup.listeners.clear();
    reanimated.sequences = 0;
    reanimated.frame = undefined;
    reanimated.active = false;
    vi.useFakeTimers();
  });

  it('holds the logo at rest until the device renders a healthy frame', async () => {
    const renderer = await mountAndReachHandover();
    const frame = reanimated.frame;
    if (!frame) {
      throw new Error('the frame callback was not registered');
    }

    // Handover done, reveal armed, nothing animating yet.
    expect(reanimated.active).toBe(true);
    expect(reanimated.sequences).toBe(0);

    // First frame reports no delta, the next one is a 300ms handover stall.
    // Starting on either would paint the reveal already part-way through.
    act(() => {
      frame({ timeSincePreviousFrame: null });
    });
    expect(reanimated.sequences).toBe(0);
    act(() => {
      frame({ timeSincePreviousFrame: 300 });
    });
    expect(reanimated.sequences).toBe(0);

    // A frame the device actually rendered starts the reveal.
    act(() => {
      frame({ timeSincePreviousFrame: 16 });
    });
    expect(reanimated.sequences).toBe(1);

    act(() => {
      renderer.unmount();
    });
    vi.useRealTimers();
  });

  it('stays armed when the logo-waive timer re-renders after the handover', async () => {
    const renderer = await mountAndReachHandover();

    // The 500ms logo-waive timer fires whether or not the logo loaded, so it
    // re-renders after the handover. That must not disarm the reveal.
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(reanimated.active).toBe(true);

    const frame = reanimated.frame;
    if (!frame) {
      throw new Error('the frame callback was not registered');
    }
    act(() => {
      frame({ timeSincePreviousFrame: 16 });
    });
    expect(reanimated.sequences).toBe(1);

    act(() => {
      renderer.unmount();
    });
    vi.useRealTimers();
  });

  it('starts the reveal anyway when no healthy frame ever arrives', async () => {
    const renderer = await mountAndReachHandover();
    expect(reanimated.sequences).toBe(0);

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(reanimated.sequences).toBe(1);

    act(() => {
      renderer.unmount();
    });
    vi.useRealTimers();
  });
});

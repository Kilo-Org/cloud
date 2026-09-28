import * as SplashScreen from 'expo-splash-screen';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as startupTiming from '@/lib/startup-timing';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const platform = vi.hoisted(() => ({ OS: 'ios' }));
vi.mock('react-native', () => ({ Platform: platform }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  useSharedValue: (v: unknown) => ({ value: v }),
  useAnimatedStyle: () => ({}),
  withTiming: (v: unknown) => v,
  withDelay: (_delay: number, v: unknown) => v,
  withSequence: (...values: unknown[]) => values.at(-1),
  makeMutable: (v: unknown) => ({ value: v }),
  Easing: { out: (v: unknown) => v, in: (v: unknown) => v, quad: 0, cubic: 0 },
  useFrameCallback: () => ({ setActive: () => undefined }),
}));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({ reducedMotion: true, scrollAnimated: false }),
}));
vi.mock('react-native-worklets', () => ({
  scheduleOnRN: vi.fn(),
}));
vi.mock('expo-splash-screen', () => ({
  hideAsync: vi.fn().mockResolvedValue(undefined),
  preventAutoHideAsync: vi.fn(),
}));
vi.mock('@sentry/react-native', () => ({ TimeToFullDisplay: () => null }));
// String host so findByType can assert the splash status bar override.
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }));
// String host so findByType works and props.onLoad stays callable.
vi.mock('@/components/ui/image', () => ({ Image: 'Image' }));
// No Vitest project transforms .png.
vi.mock('@/../assets/images/logo-mark.png', () => ({ default: 1 }));

// ── Helpers ────────────────────────────────────────────────────────────────

function findByType(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

async function mountOverlay(): Promise<TestRenderer.ReactTestRenderer> {
  const { AnimatedSplashOverlay } = await import('./animated-splash-overlay');
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(AnimatedSplashOverlay));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe.each(['ios', 'android'])('AnimatedSplashOverlay on %s', os => {
  let startup = startupTiming;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    platform.OS = os;
    startup = await import('@/lib/startup-timing');
    // React 19 requires the act environment flag before `act` supports
    // updates scheduled from external stores (useSyncExternalStore).
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    'app',
    'login',
    'consent',
    'force-update',
    'user-error',
    'consent-error',
    'language-error',
    'restore-error',
  ] as const)('hands over the same branded surface to the %s outcome', async outcome => {
    const renderer = await mountOverlay();

    // Before completion: the logo frame is mounted and hide has not fired.
    const logoImages = findByType(renderer.root, 'Image');
    expect(logoImages).toHaveLength(1);
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
    expect(logoImages[0]?.props.className).toBe('h-[100px] w-[100px]');
    expect(findByType(renderer.root, 'Animated.View')[0]?.props.className).toBe(
      'absolute inset-0 items-center justify-center bg-[#FAF74F]'
    );

    // The yellow frame forces dark status bar icons in either theme.
    const statusBars = findByType(renderer.root, 'StatusBar');
    expect(statusBars).toHaveLength(1);
    expect(statusBars[0]?.props.style).toBe('dark');

    const logoImage = logoImages[0];
    if (!logoImage) {
      throw new Error('expected one Image host');
    }

    // The logo asset decodes.
    act(() => {
      (logoImage.props.onLoad as () => void)();
    });

    // Gates settle.
    act(() => {
      startup.markStartupComplete(outcome);
    });

    // Flush microtasks so the awaited hideAsync race settles and dismissal lands.
    await act(async () => {
      await Promise.resolve();
    });

    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
    expect(findByType(renderer.root, 'Image')).toHaveLength(0);
    expect(findByType(renderer.root, 'StatusBar')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps one full-size branded surface until startup settles, even after the logo timeout', async () => {
    const renderer = await mountOverlay();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();
    expect(findByType(renderer.root, 'Image')).toHaveLength(1);
    expect(findByType(renderer.root, 'Animated.View')[0]?.props.className).toBe(
      'absolute inset-0 items-center justify-center bg-[#FAF74F]'
    );

    act(() => {
      renderer.unmount();
    });
  });

  it('does not trap the ready screen if the bundled logo never reports loading', async () => {
    const renderer = await mountOverlay();
    act(() => {
      startup.markStartupComplete('app');
    });
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(SplashScreen.hideAsync).toHaveBeenCalledTimes(1);
    expect(findByType(renderer.root, 'Image')).toHaveLength(0);

    act(() => {
      renderer.unmount();
    });
  });

  it('does not replay the splash after an already completed launch', async () => {
    startup.markStartupComplete('app');
    const renderer = await mountOverlay();

    expect(findByType(renderer.root, 'Image')).toHaveLength(0);
    expect(SplashScreen.hideAsync).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });
});

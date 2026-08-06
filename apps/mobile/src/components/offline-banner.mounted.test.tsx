/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as fixed-part-row.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OfflineBanner } from './offline-banner';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({ isOffline: false }));
const announceForA11y = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));
vi.mock('lucide-react-native', () => ({
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/ui/text', () => ({
  Text: 'Text',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ warnForeground: '#FFFFFF' }),
}));
vi.mock('@/lib/a11y/announce', () => ({
  announceForA11y,
}));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useOfflineBannerState: () => state.isOffline,
}));

// ── Helpers ────────────────────────────────────────────────────────────────

async function mountBanner(): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(OfflineBanner));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findHost(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => node.type === type);
}

describe('OfflineBanner mounted', () => {
  beforeEach(() => {
    state.isOffline = false;
    announceForA11y.mockClear();
  });

  it('renders nothing while online and never announces', async () => {
    const renderer = await mountBanner();

    expect(renderer.toJSON()).toBeNull();
    expect(announceForA11y).not.toHaveBeenCalled();
  });

  it('renders the banner on an offline mount without announcing the initial state', async () => {
    state.isOffline = true;
    const renderer = await mountBanner();

    expect(findHost(renderer.root, 'Animated.View')).toHaveLength(1);
    expect(findHost(renderer.root, 'Text')).toHaveLength(1);
    expect(announceForA11y).not.toHaveBeenCalled();
  });

  it('shows the banner with touch transparency, safe-area top, alert semantics, and announces on the online→offline transition', async () => {
    const renderer = await mountBanner();
    state.isOffline = true;
    await act(async () => {
      renderer.update(createElement(OfflineBanner));
      await Promise.resolve();
    });

    expect(findHost(renderer.root, 'Text')[0]?.props.children).toBe('No internet connection');
    const outer = findHost(renderer.root, 'View')[0];
    expect(outer?.props.pointerEvents).toBe('none');
    expect(outer?.props.style).toEqual({ top: 47 });
    const alert = findHost(renderer.root, 'Animated.View')[0];
    expect(alert?.props.accessibilityRole).toBe('alert');
    expect(alert?.props.accessibilityLabel).toBe('No internet connection');
    expect(findHost(renderer.root, 'WifiOff')).toHaveLength(1);
    expect(announceForA11y).toHaveBeenCalledTimes(1);
    expect(announceForA11y).toHaveBeenCalledWith('No internet connection');
  });

  it('hides the banner and announces restoration on the offline→online transition', async () => {
    const renderer = await mountBanner();
    state.isOffline = true;
    await act(async () => {
      renderer.update(createElement(OfflineBanner));
      await Promise.resolve();
    });
    expect(findHost(renderer.root, 'Animated.View')).toHaveLength(1);

    state.isOffline = false;
    await act(async () => {
      renderer.update(createElement(OfflineBanner));
      await Promise.resolve();
    });

    expect(renderer.toJSON()).toBeNull();
    expect(announceForA11y).toHaveBeenCalledTimes(2);
    expect(announceForA11y).toHaveBeenNthCalledWith(1, 'No internet connection');
    expect(announceForA11y).toHaveBeenNthCalledWith(2, 'Internet connection restored');
  });
});

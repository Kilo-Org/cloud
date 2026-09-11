/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts React/RN trees without a DOM */
/**
 * SPOT-DEFECT (e6-offline-new-session): the app-wide OfflineBanner is an
 * absolute overlay at the safe-area top, exactly where ScreenHeader draws its
 * title, so on the New session screen the amber "No internet connection" bar
 * overlapped and clipped the "New session" title.
 *
 * This suite mounts the REAL banner and the REAL header together (the same
 * sibling order as AppRootProviders: header first, banner last) and asserts
 * the geometric invariant the fix must hold: while the banner is visible, the
 * header's content starts strictly below the banner's bottom edge, and the
 * reservation tracks the banner's measured height (any font scale), not a
 * guess.
 */
import { type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { OfflineBanner } from './offline-banner';
import { ScreenHeader } from './screen-header';
import { getOfflineBannerHeight, setOfflineBannerHeight } from '@/lib/offline-banner-layout';

const offline = vi.hoisted(() => ({ current: false }));
const announceForA11y = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
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
vi.mock('@/components/ui/icons', () => ({
  ChevronDown: 'ChevronDown',
  WifiOff: 'WifiOff',
}));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronLeft: 'DirectionalChevronLeft',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/eyebrow', () => ({ Eyebrow: 'Eyebrow' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#000', warnForeground: '#fff' }),
}));
vi.mock('@/lib/a11y/announce', () => ({ announceForA11y }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useOfflineBannerState: () => offline.current,
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ canGoBack: () => true, back: vi.fn(), replace: vi.fn() }),
}));

const STATUS_BAR_TOP = 47;
// The New session screen's header (new-session-screen-body.tsx) — the exact
// title the spot check saw clipped.
const NEW_SESSION_TITLE = 'New session';

function AppTree(): ReactElement {
  // Same stacking as AppRootProviders: screen content first, banner last, so
  // the absolute overlay paints over whatever the header puts at the top.
  return (
    <>
      <ScreenHeader title={NEW_SESSION_TITLE} />
      <OfflineBanner />
    </>
  );
}

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function mount(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(<AppTree />);
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  renderer = ref.current;
  return renderer;
}

function rerender(): void {
  act(() => {
    renderer?.update(<AppTree />);
  });
}

/** The header's outer container — the only host View carrying paddingTop. */
function headerContainer(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const views = root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      (node.props.style as { paddingTop?: number } | undefined)?.paddingTop !== undefined
  );
  const header = views[0];
  if (!header) {
    throw new Error('header container not found');
  }
  return header;
}

function headerPaddingTop(root: TestRenderer.ReactTestInstance): number {
  return (headerContainer(root).props.style as { paddingTop: number }).paddingTop;
}

/** The banner's absolute wrapper — the only host View with pointerEvents none. */
function bannerOverlay(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const views = root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      node.props.pointerEvents === 'none'
  );
  const overlay = views[0];
  if (!overlay) {
    throw new Error('offline banner overlay not found');
  }
  return overlay;
}

function bannerBar(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  const bars = root.findAll(node => (node.type as string) === 'Animated.View');
  const bar = bars[0];
  if (!bar) {
    throw new Error('offline banner bar not found');
  }
  return bar;
}

function bannerOverlayCount(root: TestRenderer.ReactTestInstance): number {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      node.props.pointerEvents === 'none'
  ).length;
}

/**
 * The layout engine reports the bar's rendered box. `height` stands in for the
 * text metrics (it grows with the device font scale), so the reservation must
 * follow the measurement, never a constant.
 */
function reportBannerLayout(root: TestRenderer.ReactTestInstance, height: number): void {
  const bar = bannerBar(root);
  act(() => {
    (bar.props.onLayout as (event: unknown) => void)({
      nativeEvent: { layout: { x: 0, y: 0, width: 412, height } },
    });
  });
}

function bannerBottomEdge(root: TestRenderer.ReactTestInstance): number {
  const top = (bannerOverlay(root).props.style as { top: number }).top;
  return top + getOfflineBannerHeight();
}

describe('OfflineBanner vs ScreenHeader layout (e6 clipping defect)', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    offline.current = false;
    setOfflineBannerHeight(0);
    announceForA11y.mockClear();
  });
  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
    offline.current = false;
    setOfflineBannerHeight(0);
  });

  it('leaves the header at its plain safe-area padding while online', () => {
    const tree = mount();
    expect(tree.toJSON()).not.toBeNull();
    expect(headerPaddingTop(tree.root)).toBe(STATUS_BAR_TOP + 8);
    // No banner painted, so nothing reserved.
    expect(bannerOverlayCount(tree.root)).toBe(0);
    expect(getOfflineBannerHeight()).toBe(0);
  });

  it('reserves the measured banner height so the title sits below the bar', () => {
    const tree = mount();
    offline.current = true;
    rerender();

    // The bar is painted at the safe-area top, as an overlay.
    const overlay = bannerOverlay(tree.root);
    expect((overlay.props.style as { top: number }).top).toBe(STATUS_BAR_TOP);
    expect(overlay.props.pointerEvents).toBe('none');

    // Before the layout pass there is nothing to reserve; the measurement is
    // what drives the header.
    reportBannerLayout(tree.root, 36);

    expect(getOfflineBannerHeight()).toBe(36);
    expect(headerPaddingTop(tree.root)).toBe(STATUS_BAR_TOP + 8 + 36);
    // The defect: title row started at insets.top + 8, inside the bar's
    // [insets.top, insets.top + height] band. Now it must clear the bottom.
    expect(headerPaddingTop(tree.root)).toBeGreaterThan(bannerBottomEdge(tree.root));
  });

  it('tracks a taller bar at large font scale instead of clipping again', () => {
    const tree = mount();
    offline.current = true;
    rerender();
    reportBannerLayout(tree.root, 36);
    expect(headerPaddingTop(tree.root)).toBe(STATUS_BAR_TOP + 8 + 36);

    // Font scale grows the bar; the reservation follows the new measurement.
    reportBannerLayout(tree.root, 52);
    expect(headerPaddingTop(tree.root)).toBe(STATUS_BAR_TOP + 8 + 52);
    expect(headerPaddingTop(tree.root)).toBeGreaterThan(bannerBottomEdge(tree.root));
  });

  it('clears the reservation when the banner hides, restoring the header', () => {
    const tree = mount();
    offline.current = true;
    rerender();
    reportBannerLayout(tree.root, 36);
    expect(getOfflineBannerHeight()).toBe(36);

    offline.current = false;
    rerender();
    expect(bannerOverlayCount(tree.root)).toBe(0);
    expect(getOfflineBannerHeight()).toBe(0);
    expect(headerPaddingTop(tree.root)).toBe(STATUS_BAR_TOP + 8);
  });

  it('clears the reservation when the banner unmounts while still offline', () => {
    const tree = mount();
    offline.current = true;
    rerender();
    reportBannerLayout(tree.root, 36);
    expect(getOfflineBannerHeight()).toBe(36);

    // Route teardown / app-root swap: the banner unmounts without ever
    // seeing the online transition; nothing may stay reserved.
    act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
    expect(getOfflineBannerHeight()).toBe(0);
  });
});

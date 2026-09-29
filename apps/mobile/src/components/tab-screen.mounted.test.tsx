import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TabBarLabelContext } from '@/lib/tab-bar-clearance';
import { getTabBarIconForwardHeight, getTabBarOverlayHeight } from '@/lib/tab-bar-layout';
import { renderWithProviders } from '@/test/render-with-providers';

import { TabScreenScrollView, useTabBarBottomPadding } from './tab-screen';

/** Mirrors `TAB_SCREEN_BOTTOM_GAP` in `tab-screen.tsx`. */
const TAB_SCREEN_BOTTOM_GAP = 16;
const DEFAULT_FONT_SCALE = 1.5;
const layout = vi.hoisted(() => ({
  bottom: 16,
  fontScale: 1.5,
  platform: 'android' as 'android' | 'ios',
}));
/**
 * The occlusion `useKeyboardOcclusion` reports. Mocked at the module boundary so
 * the cases below drive the shared scroll view's own decision (replace the
 * tab-bar band, report it onward) without reproducing the platform's keyboard
 * event math.
 */
const keyboard = vi.hoisted(() => ({ occlusion: 0 }));

vi.mock('@/components/kilo-chat/app-aware-keyboard-padding', () => ({
  useKeyboardOcclusion: () => ({
    keyboardHeight: keyboard.occlusion,
    keyboardOcclusion: keyboard.occlusion,
  }),
}));

vi.mock('react-native', () => ({
  // Read through a getter: the clearance cases run on the Android bar, the
  // TabScreenScrollView case below on iOS (whose overlay height has no extra
  // Android padding).
  Platform: {
    get OS() {
      return layout.platform;
    },
  },
  ScrollView: 'ScrollView',
  View: 'View',
  useWindowDimensions: () => ({ height: 320, width: 160, fontScale: layout.fontScale }),
  Keyboard: { addListener: () => ({ remove: () => undefined }) },
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: layout.bottom, left: 0, right: 0, top: 0 }),
}));

function Probe() {
  return createElement('Probe', { padding: useTabBarBottomPadding() });
}

/** The clearance `useTabBarBottomPadding` reserves under an optional label decision. */
async function clearanceFor(showLabel: boolean | null): Promise<number> {
  const probe = createElement(Probe);
  const ui =
    showLabel === null ? probe : createElement(TabBarLabelContext, { value: showLabel }, probe);
  const mounted = await renderWithProviders(ui);
  try {
    return mounted.renderer.root.findByType('Probe').props.padding as number;
  } finally {
    mounted.unmount();
  }
}

afterEach(() => {
  layout.bottom = 16;
  layout.fontScale = DEFAULT_FONT_SCALE;
  layout.platform = 'android';
  keyboard.occlusion = 0;
});

describe('tab screen bottom clearance', () => {
  it('follows the published label decision, not just the font scale', async () => {
    // At 1.5 the font-scale rule alone keeps the labels (the default answer);
    // the width rule dropped them, so the clearance must match the compact bar.
    await expect(clearanceFor(false)).resolves.toBe(
      getTabBarIconForwardHeight(layout.bottom, 'android') + TAB_SCREEN_BOTTOM_GAP
    );
  });

  it('keeps the label-inclusive height when the layout keeps the labels', async () => {
    await expect(clearanceFor(true)).resolves.toBe(
      getTabBarOverlayHeight(layout.bottom, 'android', layout.fontScale) + TAB_SCREEN_BOTTOM_GAP
    );
  });

  it('falls back to the font-scale rule outside the tabs navigator', async () => {
    layout.fontScale = 2.5;
    await expect(clearanceFor(null)).resolves.toBe(
      getTabBarIconForwardHeight(layout.bottom, 'android') + TAB_SCREEN_BOTTOM_GAP
    );
  });
});

describe('TabScreenScrollView', () => {
  it('ends the viewport at the tab bar top and keeps the final gap inside the content', async () => {
    // The bar is 84pt here (50pt base + the 34pt bottom inset), and the viewport
    // must end at its top edge so a section header at the content edge is inset
    // above the bar. Insetting it by the extra 16pt gap cut the dark landscape
    // Home EXPLORE header mid-text 16pt above the bar (landscape spot defect e1).
    layout.platform = 'ios';
    layout.bottom = 34;
    layout.fontScale = 1;
    const { renderer, unmount } = await renderWithProviders(
      createElement(TabScreenScrollView, null, createElement('Content'))
    );
    const findByType = (type: string) =>
      renderer.root.findAll(node => typeof node.type === 'string' && node.type === type);
    const scroll = findByType('ScrollView')[0];

    expect(scroll?.props.style).toEqual([undefined, { marginBottom: 84 }]);
    // The final gap is breathing room for the last row, so it rides on a
    // trailing spacer inside the scroll content instead of on the viewport.
    const childTypes = scroll?.children.map(child =>
      typeof child === 'string' ? child : child.type
    );
    expect(childTypes).toEqual(['Content', 'View']);
    const [spacer] = findByType('View');
    expect(spacer?.props.style).toEqual({ height: 16 });
    unmount();
  });
});

describe('TabScreenScrollView keyboard occlusion', () => {
  it('replaces the tab-bar band with the IME occlusion so the two never stack', async () => {
    layout.platform = 'android';
    layout.bottom = 16;
    layout.fontScale = 1.5;
    keyboard.occlusion = 300;
    const { renderer, unmount } = await renderWithProviders(
      createElement(TabScreenScrollView, null, createElement('Content'))
    );
    const [scroll] = renderer.root.findAllByType('ScrollView', { deep: false });
    // 300, not 300 + the tab-bar height: `tabBarHideOnKeyboard` hides the bar, so
    // the band is replaced while the IME is up.
    expect(scroll?.props.style).toEqual([undefined, { marginBottom: 300 }]);
    unmount();
  });

  it('leaves the IME to the native inset when an iOS caller opts in', async () => {
    // The input screens set `automaticallyAdjustKeyboardInsets`, which reserves
    // the IME and reveals the focused field natively. Folding the occlusion into
    // the frame margin as well would book it twice, so the frame keeps no
    // keyboard margin here (the tab bar hides while the IME is up).
    layout.platform = 'ios';
    layout.bottom = 34;
    layout.fontScale = 1;
    keyboard.occlusion = 300;
    const { renderer, unmount } = await renderWithProviders(
      createElement(
        TabScreenScrollView,
        { automaticallyAdjustKeyboardInsets: true },
        createElement('Content')
      )
    );
    const [scroll] = renderer.root.findAllByType('ScrollView', { deep: false });
    expect(scroll?.props.style).toEqual([undefined, { marginBottom: 0 }]);
    unmount();
  });

  it('reports the reserved occlusion and defaults keyboardShouldPersistTaps', async () => {
    layout.platform = 'android';
    keyboard.occlusion = 250;
    const reports: number[] = [];
    const { renderer, unmount } = await renderWithProviders(
      createElement(
        TabScreenScrollView,
        {
          onKeyboardOcclusionChange: (occlusion: number) => {
            reports.push(occlusion);
          },
        },
        createElement('Content')
      )
    );
    const [scroll] = renderer.root.findAllByType('ScrollView', { deep: false });
    expect(scroll?.props.keyboardShouldPersistTaps).toBe('handled');
    expect(reports.at(-1)).toBe(250);
    unmount();
  });

  it('honours an explicit keyboardShouldPersistTaps', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(
        TabScreenScrollView,
        { keyboardShouldPersistTaps: 'never' },
        createElement('Content')
      )
    );
    const [scroll] = renderer.root.findAllByType('ScrollView', { deep: false });
    expect(scroll?.props.keyboardShouldPersistTaps).toBe('never');
    unmount();
  });
});

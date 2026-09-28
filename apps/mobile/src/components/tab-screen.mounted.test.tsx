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

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TabBarLabelContext } from '@/lib/tab-bar-clearance';
import { getTabBarIconForwardHeight, getTabBarOverlayHeight } from '@/lib/tab-bar-layout';
import { renderWithProviders } from '@/test/render-with-providers';

import { useTabBarBottomPadding } from './tab-screen';

/** Mirrors `TAB_SCREEN_BOTTOM_GAP` in `tab-screen.tsx`. */
const TAB_SCREEN_BOTTOM_GAP = 16;
const DEFAULT_FONT_SCALE = 1.5;
const layout = vi.hoisted(() => ({ bottom: 16, fontScale: 1.5 }));

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  ScrollView: 'ScrollView',
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
  layout.fontScale = DEFAULT_FONT_SCALE;
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

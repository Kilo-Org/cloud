import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
 * The keyboard height `useKeyboardState` reports. Mocked at the module boundary
 * so the cases below drive the shared scroll view's own decision (replace the
 * tab-bar band, report it onward) without reproducing the platform's keyboard
 * events.
 */
const keyboard = vi.hoisted(() => ({ occlusion: 0 }));
/** Captures `scrollFocusedInputAboveKeyboard` calls at the module boundary. */
const reveal = vi.hoisted(() => ({ fn: vi.fn() }));

vi.mock('react-native-keyboard-controller', () => ({
  useKeyboardState: <T,>(selector: (state: { height: number }) => T) =>
    selector({ height: keyboard.occlusion }),
}));

vi.mock('@/lib/keyboard-reveal', () => ({
  scrollFocusedInputAboveKeyboard: reveal.fn,
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

/**
 * The clearance `useTabBarBottomPadding` reserves under a tab-bar context: a
 * boolean is the tabs layout's label decision, `null` is the root stack (no
 * bar), `undefined` is a screen rendered under neither layout.
 */
async function clearanceFor(showLabel: boolean | null | undefined): Promise<number> {
  const probe = createElement(Probe);
  const ui =
    showLabel === undefined
      ? probe
      : createElement(
          TabBarLabelContext,
          { value: showLabel === null ? null : { showLabel, labelLines: 1 } },
          probe
        );
  const mounted = await renderWithProviders(ui);
  try {
    return mounted.renderer.root.findByType('Probe').props.padding as number;
  } finally {
    mounted.unmount();
  }
}

/** A scroll-frame layout event for the reveal test. */
const frame = (width: number, height: number) => ({
  nativeEvent: { layout: { width, height, x: 0, y: 0 } },
});

beforeEach(() => {
  // The reveal fires through a 400ms settle timer; fake timers drive it.
  vi.useFakeTimers();
});

afterEach(() => {
  layout.bottom = 16;
  layout.fontScale = DEFAULT_FONT_SCALE;
  layout.platform = 'android';
  keyboard.occlusion = 0;
  reveal.fn.mockClear();
  vi.useRealTimers();
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
      getTabBarOverlayHeight({
        bottomInset: layout.bottom,
        platform: 'android',
        fontScale: layout.fontScale,
      }) + TAB_SCREEN_BOTTOM_GAP
    );
  });

  it('clears only the safe-area inset on a root-stack screen', async () => {
    // The root stack draws no bar under its own screens, so their content
    // clears the inset alone; a bar's height here would leave a blank strip.
    layout.fontScale = 2.5;
    await expect(clearanceFor(null)).resolves.toBe(layout.bottom + TAB_SCREEN_BOTTOM_GAP);
  });

  it('keeps the font-scale rule for a screen rendered under neither layout', async () => {
    layout.fontScale = 1.5;
    await expect(clearanceFor(undefined)).resolves.toBe(
      getTabBarOverlayHeight({
        bottomInset: layout.bottom,
        platform: 'android',
        fontScale: layout.fontScale,
      }) + TAB_SCREEN_BOTTOM_GAP
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
      createElement(
        TabBarLabelContext,
        { value: { showLabel: true, labelLines: 1 } },
        createElement(TabScreenScrollView, null, createElement('Content'))
      )
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

  it('ends the viewport at the safe-area inset on a root-stack screen', async () => {
    // No tabs navigator above this screen means no bar to end above, so the
    // viewport clears the bottom inset alone instead of leaving a bar-height
    // blank strip under the last row.
    layout.platform = 'ios';
    layout.bottom = 34;
    layout.fontScale = 1;
    const { renderer, unmount } = await renderWithProviders(
      createElement(
        TabBarLabelContext,
        { value: null },
        createElement(TabScreenScrollView, null, createElement('Content'))
      )
    );
    const [scroll] = renderer.root.findAllByType('ScrollView', { deep: false });
    expect(scroll?.props.style).toEqual([undefined, { marginBottom: 34 }]);
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

  it('reserves the IME in the frame even when an iOS caller opts into the native inset', async () => {
    // `automaticallyAdjustKeyboardInsets` reserves the IME natively, but its
    // scroll reveal does not clamp programmatic scrolls to the keyboard top —
    // focused content stayed under the IME with no scroll range to drag it
    // clear. The wrapper reserves the occlusion in the frame itself and drops
    // the prop, so the viewport always ends at the IME's top edge.
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
    expect(scroll?.props.style).toEqual([undefined, { marginBottom: 300 }]);
    expect(scroll?.props.automaticallyAdjustKeyboardInsets).toBe(false);
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

  it('re-reveals the focused input when the IME opens and when the frame re-lays out', async () => {
    // Two re-layouts leave the focused row (and whatever sits under it) parked
    // behind the IME, with no scroll slack to drag it clear:
    // - the IME opening: the keyboard animation re-insets the content without a
    //   layout event, and the native focus reveal can leave the field covered,
    // - a rotation while the field stays focused: the native inset reveal runs
    //   on focus only. Both re-run the reveal once the transition has landed.
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
    const layoutHandler = (scroll as { props: { onLayout?: (event: unknown) => void } }).props
      .onLayout;
    expect(layoutHandler).toBeTypeOf('function');
    // The IME opening (keyboard state reaches 300 at mount) schedules the
    // reveal; it fires once the transition has landed.
    await act(async () => {
      await Promise.resolve(vi.advanceTimersByTime(400));
    });
    expect(reveal.fn).toHaveBeenCalledTimes(1);
    // An initial frame layout, then a size change with the IME up reschedules;
    // the timer defers past the stale-geometry layout.
    layoutHandler?.(frame(874, 402));
    layoutHandler?.(frame(402, 874));
    await act(async () => {
      await Promise.resolve(vi.advanceTimersByTime(400));
    });
    expect(reveal.fn).toHaveBeenCalledTimes(2);
    // Same-size layout pass: no reveal.
    layoutHandler?.(frame(402, 874));
    await act(async () => {
      await Promise.resolve(vi.advanceTimersByTime(400));
    });
    expect(reveal.fn).toHaveBeenCalledTimes(2);
    unmount();
    // The keyboard-open trigger is universal now: a frame-margin caller
    // (Android) with the IME up schedules too, and a same-size layout on it
    // changes nothing.
    const plain = await renderWithProviders(
      createElement(TabScreenScrollView, null, createElement('Content'))
    );
    const [plainScroll] = plain.renderer.root.findAllByType('ScrollView', { deep: false });
    const plainHandler = (plainScroll as { props: { onLayout?: (event: unknown) => void } }).props
      .onLayout;
    expect(plainHandler).toBeTypeOf('function');
    plainHandler?.(frame(874, 402));
    plainHandler?.(frame(874, 402));
    await act(async () => {
      await Promise.resolve(vi.advanceTimersByTime(400));
    });
    expect(reveal.fn).toHaveBeenCalledTimes(3);
    plain.unmount();
  });
});

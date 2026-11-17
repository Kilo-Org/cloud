/* eslint-disable max-lines -- Placement, measurement, and fallback contracts share one mounted fixture. */
import {
  act,
  type ComponentPropsWithRef,
  createElement,
  StrictMode,
  useImperativeHandle,
  useState,
} from 'react';
import {
  type LayoutChangeEvent,
  ScrollView,
  type ScrollViewInstance,
  type ScrollViewProps,
  type ViewProps,
} from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';
import { SearchX } from '@/components/ui/icons';

import { CenteredState } from './centered-state';
import { type useStateSurface } from './centered-state-surface';
import { EmptyState } from './empty-state';
import { InvalidRouteState } from './invalid-route-state';
import { QueryError } from './query-error';

type ScrollNode = ScrollViewInstance;
type Measurement = Parameters<ScrollNode['measureInWindow']>[0];
const native = vi.hoisted(() => {
  const surface: NonNullable<ReturnType<typeof useStateSurface>> = {
    frame: { top: 0, bottom: 500 },
    bounds: { top: 0, bottom: 500 },
    safeAreaTop: 0,
    safeAreaBottom: 0,
    source: 'layout',
    topInset: 0,
    bottomInset: 0,
    topReservation: 0,
    bottomReservation: 0,
    nativeViewportFillsSurface: false,
    register: vi.fn(() => vi.fn()),
  };
  const measureInWindow = vi.fn<(onMeasure: Measurement) => void>();
  const node: Partial<ScrollNode> = { measureInWindow };
  const scroll: Partial<ScrollViewInstance> = { getNativeScrollRef: () => node as ScrollNode };
  return {
    measurements: [] as Measurement[],
    surface,
    scroll,
    measureInWindow,
    window: { width: 400, height: 900 },
  };
});

vi.mock('@/components/centered-state-surface', () => ({ useStateSurface: () => native.surface }));
vi.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
vi.mock('react-native', () => ({
  PixelRatio: { roundToNearestPixel: (value: number) => Math.round(value * 2) / 2 },
  // Portrait by default, so the short-band flag the scroller publishes stays
  // false and a state inside it keeps its full stack.
  useWindowDimensions: () => ({ ...native.window, fontScale: 1 }),
  View: 'View',
  ScrollView: (props: ComponentPropsWithRef<typeof ScrollView>) => {
    const { ref, ...rest } = props;
    useImperativeHandle(ref, () => native.scroll as ScrollViewInstance, []);
    return createElement('ScrollView', rest);
  },
}));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: () => null,
  Lock: () => null,
  SearchX: () => null,
  ServerCrash: () => null,
  WifiOff: () => null,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: vi.fn<() => void>() }) }));

const contentLayout: Partial<LayoutChangeEvent> = {
  nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 700 } },
};

/**
 * The placement a state carries while its geometry is pending or rejected: the
 * content stays where it is, centered, until a measurement places it.
 */
const UNPLACED_FALLBACK_STYLE = {
  flexGrow: 1,
  justifyContent: 'center',
  paddingTop: 16,
  paddingBottom: 16,
};

async function mount(props: Partial<ComponentPropsWithRef<typeof CenteredState>> = {}) {
  let rerender: (() => void) | undefined = undefined;
  function Harness() {
    const [, setVersion] = useState(0);
    rerender = () => {
      setVersion(version => version + 1);
    };
    return (
      <CenteredState testID="state" {...props}>
        {null}
      </CenteredState>
    );
  }
  const mounted = await renderWithProviders(
    createElement(StrictMode, null, createElement(Harness))
  );
  const content = () =>
    mounted.renderer.root.findByProps({ testID: 'state-content' }).props as ViewProps;
  const contentNode = () =>
    mounted.renderer.root.findAllByProps({ testID: 'state-content' })[0] as
      | { props: ViewProps }
      | undefined;
  const scroll = () => mounted.renderer.root.findByType(ScrollView).props as ScrollViewProps;
  act(() => {
    contentNode()?.props.onLayout?.(contentLayout as LayoutChangeEvent);
  });
  return {
    ...mounted,
    content,
    contentNode,
    scroll,
    rerender: () => {
      act(() => {
        rerender?.();
      });
    },
    settle: (top = 80, height = 340) => {
      act(() => {
        for (const onMeasure of native.measurements.splice(0)) {
          onMeasure(0, top, 400, height);
        }
      });
    },
  };
}

/**
 * The state paints whatever its placement status. No caller hides it behind a
 * measurement window any more, so its content stays at full opacity and in the
 * accessibility tree from the first frame — a hidden data state is a blank
 * body, which is what a reopened screen used to show.
 */
function expectPainted(mounted: { content: () => ViewProps }) {
  const content = mounted.content();
  expect(content.className ?? '').not.toContain('opacity-0');
  expect(content.importantForAccessibility).not.toBe('no-hide-descendants');
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  native.surface = {
    frame: { top: 0, bottom: 500 },
    bounds: { top: 0, bottom: 500 },
    safeAreaTop: 0,
    safeAreaBottom: 0,
    source: 'layout',
    topInset: 0,
    bottomInset: 0,
    topReservation: 0,
    bottomReservation: 0,
    nativeViewportFillsSurface: false,
    register: vi.fn(() => vi.fn()),
  };
  native.measurements = [];
  native.window = { width: 400, height: 900 };
  native.measureInWindow.mockImplementation(onMeasure => {
    native.measurements.push(onMeasure);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Shared state placement', () => {
  it.each([undefined, 'center', 'top'] as const)(
    'owns one scroller only for centered placement: %s',
    async placement => {
      const mounted = await renderWithProviders(
        <EmptyState icon={SearchX} title="Empty" description="No results" placement={placement} />
      );
      expect(mounted.renderer.root.findAllByType(CenteredState)).toHaveLength(
        placement === 'top' ? 0 : 1
      );
      expect(mounted.renderer.root.findAllByType(ScrollView)).toHaveLength(
        placement === 'top' ? 0 : 1
      );
      mounted.unmount();
    }
  );

  it('publishes a short band for a phone held sideways and a tall one otherwise', async () => {
    // The Agents no-match state overflowed this band: the bubble, the copy and
    // the action need ~167dp and a 411dp-tall window leaves the band ~120dp.
    native.window = { width: 914, height: 411 };
    const landscape = await renderWithProviders(
      <EmptyState icon={SearchX} title="Empty" description="No results" />
    );
    expect(landscape.renderer.root.findAllByType(SearchX)).toHaveLength(0);
    landscape.unmount();

    // A tablet is wide but tall enough for the whole stack.
    native.window = { width: 1024, height: 768 };
    const tablet = await renderWithProviders(
      <EmptyState icon={SearchX} title="Empty" description="No results" />
    );
    expect(tablet.renderer.root.findAllByType(SearchX)).toHaveLength(1);
    tablet.unmount();

    native.window = { width: 411, height: 914 };
    const portrait = await renderWithProviders(
      <EmptyState icon={SearchX} title="Empty" description="No results" />
    );
    expect(portrait.renderer.root.findAllByType(SearchX)).toHaveLength(1);
    portrait.unmount();
  });

  it('keeps an invalid route state directly scrollable beneath a native sheet header', async () => {
    const mounted = await renderWithProviders(<InvalidRouteState backTo="/" />);
    expect(mounted.renderer.toJSON()).toMatchObject({ type: 'ScrollView' });
    mounted.unmount();
  });

  it('keeps retry and refresh on the centered error body', async () => {
    const onRetry = vi.fn<() => void>();
    const refreshControl = createElement('RefreshControl', {
      refreshing: false,
      onRefresh: vi.fn(),
    });
    const mounted = await renderWithProviders(
      <QueryError onRetry={onRetry} refreshControl={refreshControl} />
    );
    expect(mounted.renderer.root.findAllByType(ScrollView)).toHaveLength(1);
    expect(mounted.renderer.root.findByType(ScrollView).props.refreshControl).toBe(refreshControl);
    const retry = mounted.renderer.root.findByProps({ accessibilityLabel: 'common.retry' })
      .props as {
      onPress: () => void;
    };
    retry.onPress();
    expect(onRetry).toHaveBeenCalledOnce();
    mounted.unmount();
  });
});

describe('CenteredState measurements', () => {
  it('keeps a horizontal inset on the content box, not the scroller', async () => {
    // The scroller's own padding does not narrow the scroll content, so an inset
    // set through `className` leaves the end side flush in a right-to-left layout.
    const mounted = await mount({
      className: 'bg-background',
      contentContainerClassName: 'px-6',
    });
    mounted.settle();
    expect(mounted.scroll().className).toBe('flex-1 bg-background');
    expect(mounted.scroll().contentContainerClassName).toBeUndefined();
    expect(mounted.content().className).toBe('w-full px-6');
    mounted.unmount();
  });

  it.each([false, true])(
    'applies the provider native fill policy %s',
    async nativeViewportFillsSurface => {
      native.surface.nativeViewportFillsSurface = nativeViewportFillsSurface;
      const mounted = await mount();
      if (nativeViewportFillsSurface) {
        // A native-filled viewport moves the band's bottom below the scroller's
        // bottom, so the state waits for that frame instead of estimating it.
        expect(mounted.renderer.root.findAllByProps({ testID: 'state-content' })).toHaveLength(0);
        expect(mounted.scroll().contentContainerStyle).toBeUndefined();
      } else {
        expectPainted(mounted);
      }
      mounted.settle();
      expectPainted(mounted);
      expect(mounted.scroll().contentContainerStyle).toEqual({
        flexGrow: 1,
        justifyContent: nativeViewportFillsSurface ? 'center' : undefined,
        minHeight: nativeViewportFillsSurface ? 420 : 340,
        paddingTop: 16,
        paddingBottom: nativeViewportFillsSurface ? 96 : 16,
      });
      mounted.unmount();
    }
  );

  it.each([
    [
      'a reserved top inset',
      () => {
        native.surface.topInset = 48;
      },
      340,
    ],
    [
      'a native-filled viewport',
      () => {
        native.surface.nativeViewportFillsSurface = true;
      },
      420,
    ],
  ] as const)(
    'holds a state out of %s until its scroller measures',
    async (_name, band, bandHeight) => {
      // The estimate centers in the scroller and carries the bottom reserve, which
      // is the band placement only when the band starts at the scroller's top. A
      // moved band gets the scroller's own frame first, so no frame paints a
      // position the measurement then corrects.
      band();
      const mounted = await mount();
      expect(mounted.renderer.root.findAllByProps({ testID: 'state-content' })).toHaveLength(0);
      expect(mounted.scroll().contentContainerStyle).toBeUndefined();
      mounted.settle(80, 340);
      expectPainted(mounted);
      expect(mounted.scroll().contentContainerStyle).toMatchObject({ minHeight: bandHeight });
      mounted.unmount();
    }
  );

  it('paints a moved band at the estimate when the scroller cannot measure it', async () => {
    // A band that cannot be measured must still show the state: the estimate
    // keeps the bottom reserve free, which a blank body cannot do.
    native.surface.topInset = 48;
    native.surface.bottomInset = 78;
    const mounted = await mount();
    expect(mounted.renderer.root.findAllByProps({ testID: 'state-content' })).toHaveLength(0);
    act(() => {
      for (const onMeasure of native.measurements.splice(0)) {
        onMeasure(0, Number.NaN, 400, Number.NaN);
      }
    });
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual({
      flexGrow: 1,
      justifyContent: 'center',
      paddingTop: 16,
      paddingBottom: 94,
    });
    mounted.unmount();
  });

  it('waits for finite native viewport bounds without hiding the state', async () => {
    const mounted = await mount();
    act(() => {
      for (const onMeasure of native.measurements.splice(0)) {
        onMeasure(0, Number.NaN, 400, Number.NaN);
      }
    });
    // An unreadable native reading leaves the pending placement in charge; the
    // state itself stays painted.
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual(UNPLACED_FALLBACK_STYLE);
    act(() => {
      mounted.scroll().onLayout?.(contentLayout as LayoutChangeEvent);
    });
    mounted.settle();
    expect(mounted.scroll().contentContainerStyle).toMatchObject({ minHeight: 340 });
    mounted.unmount();
  });

  it('keeps its placement when the surface frame changes under it', async () => {
    // The band lives in the window, so a surface that re-measures — a returning
    // scene re-attaching its host view, a native clip edge arriving late — is no
    // reason to move a state that is already on screen.
    const mounted = await mount();
    mounted.settle(80, 340);
    act(() => {
      mounted.scroll().onLayout?.(contentLayout as LayoutChangeEvent);
    });
    const placed = mounted.scroll().contentContainerStyle;
    const stale = native.measurements.splice(0);
    native.surface.frame = { top: 300, bottom: 800 };
    mounted.rerender();
    expectPainted(mounted);
    act(() => {
      for (const onMeasure of stale) {
        onMeasure(0, 80, 400, 340);
      }
    });
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual(placed);
    mounted.unmount();
  });

  it('drops a stale viewport when the window it was measured in changes', async () => {
    const mounted = await mount();
    mounted.settle();
    act(() => {
      mounted.scroll().onLayout?.(contentLayout as LayoutChangeEvent);
    });
    expect(mounted.scroll().contentContainerStyle).toMatchObject({ minHeight: 340 });
    const stale = native.measurements.splice(0);
    native.window = { width: 400, height: 700 };
    mounted.rerender();
    // The window changed under the state: it still paints, at the pending
    // placement, while it waits for a measurement of the new band.
    expectPainted(mounted);
    act(() => {
      for (const onMeasure of stale) {
        onMeasure(0, 80, 400, 340);
      }
    });
    // A viewport measured against the old window is not reused for the new one.
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual(UNPLACED_FALLBACK_STYLE);
    mounted.settle(380, 340);
    expectPainted(mounted);
    // Content taller than the shortened band scrolls from its top, and the
    // bottom padding keeps the end of it reachable past the window clip.
    expect(mounted.scroll().contentContainerStyle).toEqual({
      flexGrow: 1,
      minHeight: 340,
      paddingTop: 16,
      paddingBottom: 36,
    });
    mounted.unmount();
  });

  it('keeps a revealed state on screen with its placement when its scroller detaches', async () => {
    const mounted = await mount();
    mounted.settle();
    act(() => {
      mounted.scroll().onLayout?.(contentLayout as LayoutChangeEvent);
    });
    const placed = mounted.scroll().contentContainerStyle;
    const stale = native.measurements.splice(0);
    const props = mounted.renderer.root.findByType(ScrollView).props as ComponentPropsWithRef<
      typeof ScrollView
    >;
    if (typeof props.ref !== 'function') {
      throw new TypeError('Expected a measuring callback ref');
    }
    const ref = props.ref;
    act(() => {
      ref(null);
    });
    // The host view re-attaches on a screen's return, and the band it had is
    // the band it still has: the placement must survive the gap rather than
    // re-center and jump back.
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual(placed);
    act(() => {
      for (const onMeasure of stale) {
        onMeasure(0, 80, 400, 340);
      }
    });
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual(placed);
    act(() => {
      ref(native.scroll as ScrollViewInstance);
    });
    mounted.settle();
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual(placed);
    mounted.unmount();
  });

  it('keeps the state painted and placed while the surface re-measures', async () => {
    const mounted = await mount();
    mounted.settle();
    expectPainted(mounted);
    const placed = mounted.scroll().contentContainerStyle;
    const frame = native.surface.frame;
    native.surface.frame = null;
    mounted.rerender();
    // The surface has no frame for a moment: the state keeps painting in the
    // window band it already measured, so it does not move.
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual(placed);
    native.surface.frame = frame;
    mounted.rerender();
    mounted.settle();
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual(placed);
    // An unreadable re-measure leaves the state painted at the pending
    // placement; the next readable measurement places it again.
    mounted.settle(0, 0);
    expectPainted(mounted);
    act(() => {
      mounted.scroll().onLayout?.(contentLayout as LayoutChangeEvent);
    });
    mounted.settle();
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual({
      flexGrow: 1,
      minHeight: 340,
      paddingTop: 16,
      paddingBottom: 16,
    });
    mounted.unmount();
  });
});

describe('CenteredState first-frame paint', () => {
  it('paints the state before the surface measures and keeps it painted', async () => {
    // A reopened screen measures its surface late, and the surface detaches and
    // re-attaches while the tab bar and the nav transition land. Hiding the
    // state for that window left an empty history body blank for more than a
    // second on a device, so the state paints at its pending placement at once.
    const mounted = await mount();
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual(UNPLACED_FALLBACK_STYLE);

    const cycle = () => {
      native.surface.frame = null;
      mounted.rerender();
      expectPainted(mounted);
      native.surface.frame = { top: 0, bottom: 500 };
      mounted.rerender();
      expectPainted(mounted);
    };
    cycle();
    cycle();

    // A real measurement still wins and replaces the pending placement.
    mounted.settle();
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual({
      flexGrow: 1,
      minHeight: 340,
      paddingTop: 16,
      paddingBottom: 16,
    });
    mounted.unmount();
  });

  it('reserves the surface bottom band once while the layout measurement is pending', async () => {
    // The tab bar is an absolute overlay: its band is known from the surface
    // reservation before any geometry lands. The fallback placement must keep
    // the content clear of it instead of centering the body under the bar — and
    // it must clear the band exactly once, so it pads by the reservation and
    // shrinks no frame (clearing it twice pushed the body half the band above
    // the centre of the visible area).
    native.surface.bottomInset = 96;
    native.surface.bottomReservation = 96;
    const mounted = await mount();
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual({
      flexGrow: 1,
      justifyContent: 'center',
      paddingTop: 16,
      paddingBottom: 112,
    });
    expect(mounted.scroll().style).toBeUndefined();
    mounted.unmount();
  });

  it('holds the state until a pending native surface reports, then paints it placed', async () => {
    // A pushed stack screen paints its surface insets 0/0 while the native
    // geometry probe is still arriving; the probe's safe-area bottom then
    // raises the band bottom and a state painted from the estimate jumped up
    // half the band change after it first appeared (explorer:android
    // layout-jump, Recent Reviews). A pending native surface is a band the
    // estimate cannot place, so the state waits for the surface's frame — and
    // its first painted placement already carries the reported insets.
    native.surface.frame = null;
    native.surface.bounds = null;
    native.surface.source = 'pending';
    native.surface.topInset = 0;
    native.surface.bottomInset = 0;
    const held = await mount();
    // No content box while the surface is pending: the scroller stays empty
    // rather than painting a position the measurement would correct.
    expect(held.contentNode()).toBeUndefined();
    expect(held.scroll().contentContainerStyle).toBeUndefined();

    // The probe reports with the device's insets. The scroller's own frame
    // reaches the window bottom, so the reported bottom inset moves the band:
    // the first painted placement must carry it, or the state would move again
    // once the content height landed (the defect this test pins).
    native.surface.source = 'native';
    native.surface.frame = { top: 0, bottom: 900 };
    native.surface.bounds = { top: 0, bottom: 900 };
    native.surface.safeAreaBottom = 24;
    native.surface.topInset = 52;
    native.surface.bottomInset = 24;
    held.rerender();
    held.settle(80, 900 - 80);
    expectPainted(held);
    // First paint: the band style built from the reported insets. The band
    // bottom sits one bottom inset above the window bottom while the scroller
    // runs to the window bottom itself, so the scroller's bottom padding
    // carries that inset; a placement built from zero insets would paint a
    // smaller padding and move when it corrected.
    expect(held.scroll().contentContainerStyle).toEqual({
      flexGrow: 1,
      minHeight: 900 - 80,
      justifyContent: 'center',
      paddingTop: 16,
      paddingBottom: 24 + 16,
    });
    // The measured layout centers the content in the same band: band top is
    // the scroller's top (the top inset sits above it) and band bottom is the
    // window bottom minus the bottom inset, so a content box of 188 centers
    // 12 higher than the zero-inset placement would place it. Asserting the
    // inset-carrying value is what proves the first paint is the final one.
    act(() => {
      held.contentNode()?.props.onLayout?.({
        nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 188 } },
      } as LayoutChangeEvent);
    });
    const placed = held.scroll().contentContainerStyle as {
      paddingTop: number;
    };
    // Band: top 80, bottom 900 - 24 = 876; (796 - 188) / 2 = 304 below the top.
    expect(placed.paddingTop).toBeCloseTo(304, 5);
    held.unmount();
  });
});

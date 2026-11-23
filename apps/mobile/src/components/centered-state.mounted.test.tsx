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
import { REFRESH_PROGRESS_REDUCED_MOTION_HEIGHT } from '@/components/ui/refresh-progress';

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
  I18nManager: { isRTL: false },
  PixelRatio: { roundToNearestPixel: (value: number) => Math.round(value * 2) / 2 },
  // Portrait by default, so the short-band flag the scroller publishes stays
  // false and a state inside it keeps its full stack.
  useColorScheme: () => 'light',
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
  ArrowLeft: () => null,
  AlertCircle: () => null,
  Lock: () => null,
  RotateCcw: () => null,
  SearchX: () => null,
  ServerCrash: () => null,
  WifiOff: () => null,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useMutedDisabledInk: () => '#777777',
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('expo-router', () => ({ useRouter: () => ({ replace: vi.fn<() => void>() }) }));

// The reduced-motion policy a mounted state reads, and the one `RefreshProgress`
// reads: both come from one provider on a device, so one mock serves both.
const motion = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock('@/lib/a11y/motion-context', () => ({
  useProvidedMotionPolicy: () => ({
    reducedMotion: motion.reducedMotion,
    scrollAnimated: !motion.reducedMotion,
  }),
}));

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
  // The scroller's own layout event is the only thing that starts a
  // measurement: a mount requests none, so a test that expects a measured
  // placement fires it before draining `native.measurements`.
  const scrollLayout = () => {
    act(() => {
      scroll().onLayout?.(contentLayout as LayoutChangeEvent);
    });
  };
  return {
    ...mounted,
    content,
    contentNode,
    scroll,
    scrollLayout,
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
  motion.reducedMotion = false;
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
  it('starts one measurement for a mount, not two', async () => {
    // The mount commit used to start two requests — the measuring callback ref
    // for the scroller and the mount layout effect — and the token guard
    // discarded one of them on every mount. The scroller's own layout event is
    // the only trigger now, so a mount plus one event is exactly one request.
    const mounted = await mount();
    expect(native.measureInWindow).not.toHaveBeenCalled();
    mounted.scrollLayout();
    expect(native.measureInWindow).toHaveBeenCalledTimes(1);
    mounted.unmount();
  });

  it('starts no second request in the commit that mounts the scroller', async () => {
    // The second request on a mount came from the mount effect, not from a
    // second layout event, so one event must cost exactly one measurement and
    // only a new event may add another.
    const mounted = await mount();
    mounted.scrollLayout();
    expect(native.measureInWindow).toHaveBeenCalledTimes(1);
    mounted.scrollLayout();
    expect(native.measureInWindow).toHaveBeenCalledTimes(2);
    mounted.unmount();
  });

  it('keeps the scroller ref callback across a window change', async () => {
    // The callback ref used to be rebuilt from the measurement, so a window
    // height change detached the node and re-attached it, which marked the
    // state unplaceable on the way back.
    const mounted = await mount();
    mounted.scrollLayout();
    mounted.settle(380, 340);
    expect(mounted.scroll().contentContainerStyle).toMatchObject({
      minHeight: 340,
      paddingBottom: 16,
    });
    expect(native.measureInWindow).toHaveBeenCalledTimes(1);
    const refBefore = (
      mounted.renderer.root.findByType(ScrollView).props as ComponentPropsWithRef<typeof ScrollView>
    ).ref;

    native.window = { width: 400, height: 700 };
    mounted.rerender();
    expect(
      (
        mounted.renderer.root.findByType(ScrollView).props as ComponentPropsWithRef<
          typeof ScrollView
        >
      ).ref
    ).toBe(refBefore);
    // The shortened band waits for its own measurement; the placement already
    // painted is not carried into a window it was not measured against.
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual(UNPLACED_FALLBACK_STYLE);

    mounted.scrollLayout();
    expect(native.measureInWindow).toHaveBeenCalledTimes(2);
    mounted.settle(380, 340);
    // The new window clips the scroller 20 above its bottom, so the placement
    // carries that clip and the state is placed, not left at the estimate.
    expect(mounted.scroll().contentContainerStyle).toEqual({
      flexGrow: 1,
      minHeight: 340,
      paddingTop: 16,
      paddingBottom: 36,
    });
    mounted.unmount();
  });

  it('keeps a horizontal inset on the content box, not the scroller', async () => {
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
      mounted.scrollLayout();
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
      band();
      const mounted = await mount();
      expect(mounted.renderer.root.findAllByProps({ testID: 'state-content' })).toHaveLength(0);
      expect(mounted.scroll().contentContainerStyle).toBeUndefined();
      mounted.scrollLayout();
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
    mounted.scrollLayout();
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
    mounted.scrollLayout();
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
    mounted.scrollLayout();
    mounted.settle(80, 340);
    mounted.scrollLayout();
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
    mounted.scrollLayout();
    mounted.settle();
    expect(mounted.scroll().contentContainerStyle).toMatchObject({ minHeight: 340 });
    // A request still in flight when the window changes describes the band it
    // was started for, so its answer must not place the state in the new one.
    mounted.scrollLayout();
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
    mounted.scrollLayout();
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
    mounted.scrollLayout();
    mounted.settle();
    mounted.scrollLayout();
    const placed = mounted.scroll().contentContainerStyle;
    const stale = native.measurements.splice(0);
    const props = mounted.renderer.root.findByType(ScrollView).props as ComponentPropsWithRef<
      typeof ScrollView
    >;
    if (typeof props.ref !== 'function') {
      throw new TypeError('Expected a measuring callback ref');
    }
    const ref = props.ref;
    const beforeDetach = native.measureInWindow.mock.calls.length;
    act(() => {
      ref(null);
    });
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
    // Recording the node only records it: neither the detach nor the re-attach
    // starts a request, so the placement stays and no answer is discarded.
    expect(native.measureInWindow.mock.calls).toHaveLength(beforeDetach);
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual(placed);
    mounted.scrollLayout();
    expect(native.measureInWindow.mock.calls).toHaveLength(beforeDetach + 1);
    mounted.settle();
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual(placed);
    mounted.unmount();
  });

  it('keeps the state painted and placed while the surface re-measures', async () => {
    const mounted = await mount();
    mounted.scrollLayout();
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
    expectPainted(mounted);
    expect(mounted.scroll().contentContainerStyle).toEqual(placed);
    // An unreadable re-measure leaves the state painted at the pending
    // placement; the next readable measurement places it again.
    mounted.scrollLayout();
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
    mounted.scrollLayout();
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
    held.scrollLayout();
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
    const layout188: Partial<LayoutChangeEvent> = {
      nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 188 } },
    };
    act(() => {
      held.contentNode()?.props.onLayout?.(layout188 as LayoutChangeEvent);
    });
    const placed = held.scroll().contentContainerStyle as {
      paddingTop: number;
    };
    // Band: top 80, bottom 900 - 24 = 876; (796 - 188) / 2 = 304 below the top.
    expect(placed.paddingTop).toBeCloseTo(304, 5);
    held.unmount();

    // The scroller can also measure before the probe reports (the surface's
    // capture installs on focus). The measured path must hold too: with a
    // measured viewport but a pending surface, no content box paints — a
    // placement built from the scroller frame alone would move when the
    // probe's insets landed.
    native.surface.frame = null;
    native.surface.bounds = null;
    native.surface.source = 'pending';
    native.surface.topInset = 0;
    native.surface.bottomInset = 0;
    const heldLate = await mount();
    heldLate.scrollLayout();
    heldLate.settle(80, 900 - 80);
    expect(heldLate.contentNode()).toBeUndefined();
    expect(heldLate.scroll().contentContainerStyle).toBeUndefined();

    // The probe reports while the scroller stays measured: the first painted
    // placement carries the insets immediately.
    native.surface.source = 'native';
    native.surface.frame = { top: 0, bottom: 900 };
    native.surface.bounds = { top: 0, bottom: 900 };
    native.surface.safeAreaBottom = 24;
    native.surface.topInset = 52;
    native.surface.bottomInset = 24;
    heldLate.rerender();
    heldLate.settle(80, 900 - 80);
    const layoutLate: Partial<LayoutChangeEvent> = {
      nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 188 } },
    };
    act(() => {
      heldLate.contentNode()?.props.onLayout?.(layoutLate as LayoutChangeEvent);
    });
    const placedLate = heldLate.scroll().contentContainerStyle as {
      paddingTop: number;
    };
    expect(placedLate.paddingTop).toBeCloseTo(304, 5);
    heldLate.unmount();
  });
});

describe('CenteredState reduced-motion refresh reserve', () => {
  // `RefreshProgress` is the first in-flow child of the measured content box, so
  // under reduced motion it adds its 31.5dp `h-9` box above the visible stack.
  // The placement must centre the stack, not the box that carries it.
  const refreshControl = createElement('RefreshControl', { refreshing: false });
  const RESERVE = REFRESH_PROGRESS_REDUCED_MOTION_HEIGHT;

  it('centres the visible stack above the reserve instead of the box', async () => {
    motion.reducedMotion = true;
    const reduced = await mount({ refreshControl });
    reduced.scrollLayout();
    reduced.settle(80, 820);
    const reducedStyle = reduced.scroll().contentContainerStyle as {
      minHeight: number;
      paddingTop: number;
      paddingBottom: number;
    };
    reduced.unmount();

    motion.reducedMotion = false;
    const plain = await mount({ refreshControl });
    plain.scrollLayout();
    plain.settle(80, 820);
    const plainStyle = plain.scroll().contentContainerStyle as {
      minHeight: number;
      paddingTop: number;
      paddingBottom: number;
    };
    plain.unmount();

    // The reserve is subtracted before centring, so the box that carries it
    // starts half the reserve higher: 15.75dp, reported as 15.5 because the
    // harness rounds every padding to half a pixel.
    expect(plainStyle.paddingTop - reducedStyle.paddingTop).toBe(15.5);

    // The band is the scroller's 80..900, its centre 490. The visible stack
    // starts one reserve below the box and is [contentHeight - reserve] tall,
    // so its centre lands on the band's centre rather than 15.75 below it.
    const stackTop = reducedStyle.paddingTop + 80 + RESERVE;
    expect(stackTop + (700 - RESERVE) / 2).toBeCloseTo(490, 0);

    // No refresh control reserves nothing: the placement is what it always was.
    motion.reducedMotion = true;
    const plainWithoutRefresh = await mount();
    plainWithoutRefresh.scrollLayout();
    plainWithoutRefresh.settle(80, 820);
    expect(plainWithoutRefresh.scroll().contentContainerStyle).toEqual({
      flexGrow: 1,
      minHeight: 820,
      paddingTop: 60,
      paddingBottom: 60,
    });
    plainWithoutRefresh.unmount();
  });
});

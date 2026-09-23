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
  type ScrollViewProps,
  type ViewProps,
} from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';
import { SearchX } from '@/components/ui/icons';
import { RefreshProgress } from '@/components/ui/refresh-progress';

import { CenteredState, STATE_SURFACE_FALLBACK_MS } from './centered-state';
import { type useStateSurface } from './centered-state-surface';
import { EmptyState } from './empty-state';
import { InvalidRouteState } from './invalid-route-state';
import { QueryError } from './query-error';

type ScrollNode = NonNullable<ReturnType<ScrollView['getNativeScrollRef']>>;
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
  const scroll: Partial<ScrollView> = { getNativeScrollRef: () => node as ScrollNode };
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
    useImperativeHandle(ref, () => native.scroll as ScrollView, []);
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

async function mount() {
  let rerender: (() => void) | undefined = undefined;
  function Harness() {
    const [, setVersion] = useState(0);
    rerender = () => {
      setVersion(version => version + 1);
    };
    return <CenteredState testID="state">{null}</CenteredState>;
  }
  const mounted = await renderWithProviders(
    createElement(StrictMode, null, createElement(Harness))
  );
  const content = () =>
    mounted.renderer.root.findByProps({ testID: 'state-content' }).props as ViewProps;
  const scroll = () => mounted.renderer.root.findByType(ScrollView).props as ScrollViewProps;
  act(() => {
    content().onLayout?.(contentLayout as LayoutChangeEvent);
  });
  return {
    ...mounted,
    content,
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

  it('drops the pull progress strip in a short band only where the band draws it', async () => {
    // Landscape UX defect e1: the strip the reduced-motion pull reserves is
    // measured as part of the body, so a 411dp-tall landscape band could not
    // hold it and the state's copy and its action — on the Agents no-match
    // state that reservation pushed the second line and the Clear-search action
    // under the fixed tab bar. Only the surface whose own reserved band draws
    // the pull (`progressInBand`) may yield the strip there; a centered
    // refreshable surface with no band to fall back on keeps it, because the
    // strip is the pull's only reduced-motion indicator.
    const refreshControl = createElement('RefreshControl', {
      refreshing: false,
      onRefresh: vi.fn(),
    });
    const state = (progressInBand?: boolean) =>
      createElement(EmptyState, {
        icon: SearchX,
        title: 'Empty',
        description: 'No results',
        refreshControl,
        progressInBand,
      });

    native.window = { width: 914, height: 411 };
    const banded = await renderWithProviders(state(true));
    expect(banded.renderer.root.findAllByType(RefreshProgress)).toHaveLength(0);
    banded.unmount();

    const bandless = await renderWithProviders(state());
    expect(bandless.renderer.root.findAllByType(RefreshProgress)).toHaveLength(1);
    bandless.unmount();

    native.window = { width: 411, height: 914 };
    const portrait = await renderWithProviders(state(true));
    expect(portrait.renderer.root.findAllByType(RefreshProgress)).toHaveLength(1);
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
  it.each([false, true])(
    'applies the provider native fill policy %s',
    async nativeViewportFillsSurface => {
      native.surface.nativeViewportFillsSurface = nativeViewportFillsSurface;
      const mounted = await mount();
      expect(mounted.content().accessibilityElementsHidden).toBe(true);
      mounted.settle();
      expect(mounted.content().accessibilityElementsHidden).toBe(false);
      expect(mounted.scroll().contentContainerStyle).toEqual({
        flexGrow: 1,
        minHeight: nativeViewportFillsSurface ? 420 : 340,
        paddingTop: 16,
        paddingBottom: nativeViewportFillsSurface ? 96 : 16,
      });
      mounted.unmount();
    }
  );

  it('rejects old viewport results after the surface changes', async () => {
    const mounted = await mount();
    mounted.settle();
    act(() => {
      mounted.scroll().onLayout?.(contentLayout as LayoutChangeEvent);
    });
    const stale = native.measurements.splice(0);
    native.surface.frame = { top: 300, bottom: 800 };
    mounted.rerender();
    expect(mounted.content().accessibilityElementsHidden).toBe(true);
    act(() => {
      for (const onMeasure of stale) {
        onMeasure(0, 80, 400, 340);
      }
    });
    expect(mounted.content().accessibilityElementsHidden).toBe(true);
    mounted.settle(380, 340);
    expect(mounted.content().accessibilityElementsHidden).toBe(false);
    mounted.unmount();
  });

  it('clears readiness on detach and ignores the detached request', async () => {
    const mounted = await mount();
    mounted.settle();
    act(() => {
      mounted.scroll().onLayout?.(contentLayout as LayoutChangeEvent);
    });
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
    expect(mounted.content().accessibilityElementsHidden).toBe(true);
    act(() => {
      for (const onMeasure of stale) {
        onMeasure(0, 80, 400, 340);
      }
    });
    expect(mounted.content().accessibilityElementsHidden).toBe(true);
    act(() => {
      ref(native.scroll as ScrollView);
    });
    mounted.settle();
    expect(mounted.content().accessibilityElementsHidden).toBe(false);
    mounted.unmount();
  });

  it('waits for a new valid measurement after the surface detaches', async () => {
    const mounted = await mount();
    mounted.settle();
    const frame = native.surface.frame;
    native.surface.frame = null;
    mounted.rerender();
    expect(mounted.content().accessibilityElementsHidden).toBe(true);
    native.surface.frame = frame;
    mounted.rerender();
    expect(mounted.content().accessibilityElementsHidden).toBe(true);
    mounted.settle(0, 0);
    expect(mounted.content().accessibilityElementsHidden).toBe(true);
    act(() => {
      mounted.scroll().onLayout?.(contentLayout as LayoutChangeEvent);
    });
    mounted.settle();
    expect(mounted.content().accessibilityElementsHidden).toBe(false);
    mounted.unmount();
  });
});

describe('CenteredState measurement fallback', () => {
  it('reveals the content once the measurement window passes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      // Never calling `settle()` is exactly the measurement that never lands:
      // the native geometry callback stays queued while the surface is
      // measured.
      const mounted = await mount();
      expect(mounted.content().accessibilityElementsHidden).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(STATE_SURFACE_FALLBACK_MS);
        await Promise.resolve();
      });

      expect(mounted.content().accessibilityElementsHidden).toBe(false);
      expect(mounted.content().className).not.toContain('opacity-0');

      // A real measurement still wins and replaces the fallback placement.
      mounted.settle();
      expect(mounted.scroll().contentContainerStyle).toEqual({
        flexGrow: 1,
        minHeight: 340,
        paddingTop: 16,
        paddingBottom: 16,
      });
      mounted.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the hidden-until-measured contract inside the window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const mounted = await mount();
      await act(async () => {
        vi.advanceTimersByTime(STATE_SURFACE_FALLBACK_MS - 1);
        await Promise.resolve();
      });
      expect(mounted.content().accessibilityElementsHidden).toBe(true);
      mounted.unmount();
    } finally {
      vi.useRealTimers();
    }
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
    expect(mounted.content().accessibilityElementsHidden).toBe(true);
    expect(mounted.scroll().contentContainerStyle).toEqual({
      flexGrow: 1,
      justifyContent: 'center',
      paddingTop: 16,
      paddingBottom: 112,
    });
    expect(mounted.scroll().style).toBeUndefined();
    mounted.unmount();
  });
});

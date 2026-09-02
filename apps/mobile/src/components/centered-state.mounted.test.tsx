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

import { CenteredState } from './centered-state';
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
  return { measurements: [] as Measurement[], surface, scroll, measureInWindow };
});

vi.mock('@/components/centered-state-surface', () => ({ useStateSurface: () => native.surface }));
vi.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
vi.mock('react-native', () => ({
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

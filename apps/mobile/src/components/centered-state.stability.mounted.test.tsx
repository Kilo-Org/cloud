import { act, type ComponentPropsWithRef, createElement, useImperativeHandle } from 'react';
import {
  type LayoutChangeEvent,
  ScrollView,
  type ScrollViewProps,
  type ViewProps,
} from 'react-native';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';
import { CenteredState } from './centered-state';
import { type useStateSurface } from './centered-state-surface';

type ScrollNode = NonNullable<ReturnType<ScrollView['getNativeScrollRef']>>;
const native = vi.hoisted(() => {
  const surface: NonNullable<ReturnType<typeof useStateSurface>> = {
    frame: { top: 0, bottom: 800 },
    bounds: { top: 0, bottom: 800 },
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
  return { scale: 2, viewportTop: 0.5, surface };
});

vi.mock('@/components/centered-state-surface', () => ({ useStateSurface: () => native.surface }));
vi.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
vi.mock('react-native', () => ({
  PixelRatio: {
    roundToNearestPixel: (value: number) => Math.round(value * native.scale) / native.scale,
  },
  View: 'View',
  ScrollView: (props: ComponentPropsWithRef<typeof ScrollView>) => {
    const { ref, ...rest } = props;
    useImperativeHandle(ref, () => {
      const node: Partial<ScrollNode> = {
        measureInWindow: onMeasure => {
          onMeasure(0, native.viewportTop, 400, 800 - native.viewportTop);
        },
      };
      const scroll: Partial<ScrollView> = { getNativeScrollRef: () => node as ScrollNode };
      return scroll as ScrollView;
    }, []);
    return createElement('ScrollView', rest);
  },
}));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  native.scale = 2;
  native.viewportTop = 0.5;
});
afterEach(() => vi.unstubAllGlobals());

async function mount() {
  const mounted = await renderWithProviders(<CenteredState testID="state">{null}</CenteredState>);
  const measure = (height: number) => {
    const props = mounted.renderer.root.findByProps({ testID: 'state-content' }).props as ViewProps;
    const event: Partial<LayoutChangeEvent> = {
      nativeEvent: { layout: { x: 0, y: 0, width: 400, height } },
    };
    act(() => props.onLayout?.(event as LayoutChangeEvent));
  };
  const layout = () => {
    const props = mounted.renderer.root.findByType(ScrollView).props as ScrollViewProps;
    return props.contentContainerStyle as { paddingTop: number; paddingBottom: number };
  };
  return { ...mounted, measure, layout };
}

it.each([
  { scale: 2, origin: 0.25, intrinsicHeight: 100.75 },
  { scale: 3, origin: 0, intrinsicHeight: 100.25 },
])(
  'settles the root-relative rounding cycle at $scale× density',
  async ({ scale, origin, intrinsicHeight }) => {
    native.scale = scale;
    const round = (value: number) => Math.round(value * native.scale);
    native.viewportTop = round(origin) / scale;
    const mounted = await mount();
    mounted.measure((round(origin + intrinsicHeight) - round(origin)) / native.scale);
    const positions: number[] = [];
    for (let frame = 0; frame < 8; frame += 1) {
      const { paddingTop } = mounted.layout();
      positions.push(paddingTop);
      const height =
        (round(origin + paddingTop + intrinsicHeight) - round(origin + paddingTop)) / native.scale;
      mounted.measure(height);
    }
    expect(new Set(positions.slice(-4)).size).toBe(1);
    expect(mounted.layout().paddingTop * native.scale).toBeCloseTo(
      Math.round(mounted.layout().paddingTop * native.scale),
      6
    );
    mounted.unmount();
  }
);

it('normalizes fractional-pixel measurement noise but still responds to real height changes', async () => {
  native.scale = 3;
  native.viewportTop = 1 / 3;
  const mounted = await mount();
  mounted.measure(200.333_328_247_070_3);
  const first = mounted.layout();
  mounted.measure(200.333_343_505_859_38);
  expect(mounted.layout()).toEqual(first);
  mounted.measure(200.333_343_505_859_38 + 1 / native.scale);
  expect(mounted.layout().paddingTop).toBeLessThan(first.paddingTop);
  mounted.unmount();
});

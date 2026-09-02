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
  return { scale: 2, viewportTop: 0.5, viewportBottom: 800, surface };
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
          onMeasure(0, native.viewportTop, 400, native.viewportBottom - native.viewportTop);
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
  native.viewportBottom = 800;
  native.surface.frame = { top: 0, bottom: 800 };
  native.surface.bounds = { top: 0, bottom: 800 };
  native.surface.topInset = 0;
  native.surface.bottomInset = 0;
  native.surface.nativeViewportFillsSurface = false;
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
    return props.contentContainerStyle as {
      minHeight: number;
      paddingTop: number;
      paddingBottom: number;
    };
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

it.each([
  { clip: 'viewport', top: 0 },
  { clip: 'viewport', top: 100 / 3 },
  { clip: 'surface', top: 0 },
  { clip: 'inset', top: 0 },
])('keeps fractional exact-fit content inside the $clip at $top', async ({ clip, top }) => {
  native.scale = 3;
  native.viewportTop = Math.fround(top);
  const height = Math.fround(532 / native.scale);
  const bottom = native.viewportTop + height;
  if (clip === 'viewport') {
    native.viewportBottom = bottom;
  } else if (clip === 'surface') {
    native.surface.frame = { top: 0, bottom };
  } else {
    native.surface.bottomInset = 800 - bottom;
  }
  const mounted = await mount();
  mounted.measure(height);
  const fitted = mounted.layout();
  expect(fitted.paddingTop).toBe(0);
  expect(
    Math.round((fitted.paddingTop + 532 / native.scale + fitted.paddingBottom) * native.scale)
  ).toBe(Math.round((native.viewportBottom - native.viewportTop) * native.scale));
  mounted.measure(Math.fround(533 / native.scale));
  expect(mounted.layout().paddingTop).toBe(16);
  mounted.measure(height);
  expect(mounted.layout()).toEqual(fitted);
  mounted.unmount();
});

it.each([
  { scale: 2, top: 320, viewportTop: 384, bottom: 640, height: 177.5, paddingTop: 39.5 },
  { scale: 3, top: 0, viewportTop: 100, bottom: 800, height: 533 / 3, paddingTop: 634 / 3 },
])('does not add scrolling after rounding padding at $scale× density', async geometry => {
  native.scale = geometry.scale;
  native.viewportTop = geometry.viewportTop;
  native.viewportBottom = geometry.bottom;
  native.surface.frame = { top: geometry.top, bottom: geometry.bottom };
  const mounted = await mount();
  mounted.measure(geometry.height);
  const layout = mounted.layout();
  expect(layout.paddingTop).toBe(geometry.paddingTop);
  expect(layout.minHeight).toBe(geometry.bottom - geometry.viewportTop);
  expect(
    Math.round((layout.paddingTop + geometry.height + layout.paddingBottom) * native.scale)
  ).toBe(Math.round(layout.minHeight * native.scale));
  mounted.unmount();
});

it.each([
  {
    name: 'original surface center with unequal header and footer',
    bottom: 800,
    nativeBottom: 800,
    viewportBottom: 760,
    height: 200,
    nativeFill: false,
    expected: { minHeight: 680, paddingTop: 220, paddingBottom: 260 },
  },
  {
    name: 'native sheet clipped above the keyboard',
    bottom: 400,
    nativeBottom: 700,
    viewportBottom: 620,
    height: 120,
    nativeFill: true,
    expected: { minHeight: 620, paddingTop: 60, paddingBottom: 440 },
  },
  {
    name: 'overflow above the keyboard',
    bottom: 400,
    nativeBottom: 700,
    viewportBottom: 620,
    height: 800,
    nativeFill: true,
    expected: { minHeight: 620, paddingTop: 16, paddingBottom: 316 },
  },
  {
    name: 'native sheet flow footer',
    bottom: 500,
    nativeBottom: 500,
    viewportBottom: 420,
    height: 700,
    nativeFill: true,
    expected: { minHeight: 420, paddingTop: 16, paddingBottom: 96 },
  },
])('preserves the $name', async geometry => {
  native.viewportTop = 80;
  native.viewportBottom = geometry.viewportBottom;
  native.surface.frame = { top: 0, bottom: geometry.bottom };
  native.surface.bounds = { top: 0, bottom: geometry.nativeBottom };
  native.surface.nativeViewportFillsSurface = geometry.nativeFill;
  const mounted = await mount();
  mounted.measure(geometry.height);
  expect(mounted.layout()).toMatchObject(geometry.expected);
  mounted.unmount();
});

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

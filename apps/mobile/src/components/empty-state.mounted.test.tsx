// The centered empty state yields its decorative icon when the band it is being
// centered in cannot hold the full form. The band comes from the `CenteredState`
// around it; the full form's height is measured, never assumed, because it grows
// with Dynamic Type, with a title or description that wraps, and with the
// pull-to-refresh line that state renders above these children. In a 360pt
// landscape window the Agents tab's band above the tab bar is ~97pt while the
// full form needs ~167pt, so the state fell to the scroll anchor and its second
// line and action were parked behind the bar (landscape spot defect e8). The
// compact form keeps the title, its description, and the action.

import { act, type ComponentPropsWithRef, createElement, useImperativeHandle } from 'react';
import { type LayoutChangeEvent, type ScrollView, type ViewProps } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Bot } from '@/components/ui/icons';
import { renderWithProviders } from '@/test/render-with-providers';
import { type useStateSurface } from './centered-state-surface';
import { EmptyState } from './empty-state';

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
  return { viewportTop: 100, viewportBottom: 800, surface };
});

vi.mock('@/components/centered-state-surface', () => ({ useStateSurface: () => native.surface }));
vi.mock('@/components/ui/icons', () => ({ Bot: 'Bot', Loader2: 'Loader2' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));
vi.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
vi.mock('react-native', () => ({
  PixelRatio: { roundToNearestPixel: (value: number) => value },
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

type Mounted = Awaited<ReturnType<typeof renderWithProviders>>;

/** A layout report, shaped as the native layout pass delivers it. */
function layoutEvent(height: number) {
  const event: Partial<LayoutChangeEvent> = {
    nativeEvent: { layout: { x: 0, y: 0, width: 400, height } },
  };
  return event as LayoutChangeEvent;
}

function form(mounted: Mounted) {
  const node = mounted.renderer.root.findAll(
    instance =>
      String(instance.type) === 'View' &&
      typeof instance.props.onLayout === 'function' &&
      String(instance.props.className).includes('items-center px-6')
  )[0];
  if (!node) {
    throw new Error('Missing the empty state form');
  }
  return node.props as ViewProps;
}

function refreshLine(mounted: Mounted) {
  const node = mounted.renderer.root.findAll(
    instance =>
      String(instance.type) === 'View' &&
      typeof instance.props.onLayout === 'function' &&
      instance.props.className === undefined
  )[0];
  if (!node) {
    throw new Error('Missing the refresh line');
  }
  return node.props as ViewProps;
}

/** Reports the form's own layout, as the native layout pass does. */
function measureForm(mounted: Mounted, height: number) {
  act(() => {
    form(mounted).onLayout?.(layoutEvent(height));
  });
}

/** Reports the pull-to-refresh line's layout above the form. */
function measureRefreshLine(mounted: Mounted, height: number) {
  act(() => {
    refreshLine(mounted).onLayout?.(layoutEvent(height));
  });
}

function icons(mounted: Mounted) {
  return mounted.renderer.root.findAll(node => String(node.type) === 'Bot');
}

function texts(mounted: Mounted) {
  return mounted.renderer.root.findAll(node => String(node.type) === 'Text');
}

function actions(mounted: Mounted) {
  return mounted.renderer.root.findAll(node => String(node.type) === 'ClearSearchButton');
}

function formClassName(mounted: Mounted) {
  return form(mounted).className ?? '';
}

function emptyState(refreshControl?: ComponentPropsWithRef<typeof ScrollView>['refreshControl']) {
  return createElement(EmptyState, {
    icon: Bot,
    title: 'No sessions match',
    description: 'Try a different search term.',
    action: createElement('ClearSearchButton'),
    refreshControl,
  });
}

describe('EmptyState compact form', () => {
  beforeEach(() => {
    native.viewportTop = 100;
    native.viewportBottom = 800;
    native.surface.frame = { top: 0, bottom: 800 };
    native.surface.bottomInset = 0;
  });

  it('keeps the decorative icon when the measured full form fits the band', async () => {
    const mounted = await renderWithProviders(emptyState());

    measureForm(mounted, 160);

    expect(icons(mounted)).toHaveLength(1);
    mounted.unmount();
  });

  it('drops the decorative icon when the measured full form exceeds the band', async () => {
    native.viewportTop = 700;

    const mounted = await renderWithProviders(emptyState());

    measureForm(mounted, 160);

    expect(icons(mounted)).toHaveLength(0);
    // The meaning-carrying parts stay: title, description, and the action.
    expect(texts(mounted)).toHaveLength(2);
    expect(actions(mounted)).toHaveLength(1);
    mounted.unmount();
  });

  it('compacts on the measured height even where the old fixed estimate accepted the band', async () => {
    // A 180pt band cleared the constant the decision used to compare against,
    // but a form that measures 200pt (larger text, a description that wraps)
    // still cannot fit it, and the state must not fall to the scroll anchor.
    native.viewportTop = 620;

    const mounted = await renderWithProviders(emptyState());

    measureForm(mounted, 200);

    expect(icons(mounted)).toHaveLength(0);
    mounted.unmount();
  });

  it('follows the full form as its measured height changes', async () => {
    native.viewportTop = 620;
    const mounted = await renderWithProviders(emptyState());

    measureForm(mounted, 160);
    expect(icons(mounted)).toHaveLength(1);

    measureForm(mounted, 240);
    expect(icons(mounted)).toHaveLength(0);
    mounted.unmount();
  });

  it('measures the band against the reserved bottom inset, not the whole viewport', async () => {
    // The e8 geometry: a 360pt-tall landscape window whose body starts at 185pt
    // and whose tab bar is 78pt tall leaves a 97pt band. The full form cannot
    // fit even though the viewport below the header is 175pt.
    native.surface.frame = { top: 0, bottom: 360 };
    native.surface.bottomInset = 78;
    native.viewportTop = 185;
    native.viewportBottom = 360;

    const mounted = await renderWithProviders(emptyState());

    measureForm(mounted, 160);

    expect(icons(mounted)).toHaveLength(0);
    mounted.unmount();
  });

  it('takes the pull-to-refresh line above the form out of the band', async () => {
    // The line is `h-0` except under reduced motion while a pull is in flight,
    // when it takes the top of the band: a 260pt form fits a 280pt band, but not
    // the 244pt left under a 36pt line.
    native.viewportTop = 520;
    const refreshControl = createElement('RefreshControl', {
      refreshing: true,
      onRefresh: vi.fn<() => void>(),
    });
    const mounted = await renderWithProviders(emptyState(refreshControl));

    measureForm(mounted, 260);
    expect(icons(mounted)).toHaveLength(1);

    measureRefreshLine(mounted, 36);
    expect(icons(mounted)).toHaveLength(0);
    mounted.unmount();
  });

  it('holds a switched form back until its own layout has landed', async () => {
    native.viewportTop = 700;
    const mounted = await renderWithProviders(emptyState());

    measureForm(mounted, 160);
    // The band decided from the full form's measurement, so the frame that
    // still carries that height stays blank instead of placing the compact
    // form where the full one measured.
    expect(formClassName(mounted)).toContain('opacity-0');

    measureForm(mounted, 96);
    expect(formClassName(mounted)).not.toContain('opacity-0');
    mounted.unmount();
  });
});

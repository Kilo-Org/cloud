// The centered empty state yields its decorative icon when the band it is being
// centered in cannot hold the full form. In a 360pt landscape window the Agents
// tab's band above the tab bar is ~97pt while the full form needs ~167pt, so the
// state fell to the scroll anchor and its second line and action were parked
// behind the bar (landscape spot defect e8). The compact form keeps the title,
// its description, and the action.

import { type ComponentPropsWithRef, createElement, useImperativeHandle } from 'react';
import { type ScrollView } from 'react-native';
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

function emptyState() {
  return createElement(EmptyState, {
    icon: Bot,
    title: 'No sessions match',
    description: 'Try a different search term.',
    action: createElement('ClearSearchButton'),
  });
}

describe('EmptyState compact form', () => {
  beforeEach(() => {
    native.viewportTop = 100;
    native.viewportBottom = 800;
    native.surface.frame = { top: 0, bottom: 800 };
    native.surface.bottomInset = 0;
  });

  it('keeps the decorative icon when the band holds the full form', async () => {
    const mounted = await renderWithProviders(emptyState());

    expect(mounted.renderer.root.findAll(node => String(node.type) === 'Bot')).toHaveLength(1);
    mounted.unmount();
  });

  it('drops the decorative icon when the band cannot hold the full form', async () => {
    native.viewportTop = 700;

    const mounted = await renderWithProviders(emptyState());

    expect(mounted.renderer.root.findAll(node => String(node.type) === 'Bot')).toHaveLength(0);
    // The meaning-carrying parts stay: title, description, and the action.
    expect(mounted.renderer.root.findAll(node => String(node.type) === 'Text')).toHaveLength(2);
    expect(
      mounted.renderer.root.findAll(node => String(node.type) === 'ClearSearchButton')
    ).toHaveLength(1);
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

    expect(mounted.renderer.root.findAll(node => String(node.type) === 'Bot')).toHaveLength(0);
    mounted.unmount();
  });
});

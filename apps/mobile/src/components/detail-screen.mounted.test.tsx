/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native regression test. */
import { createElement, type ElementType, type ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { DetailScreenScrollView } from './detail-screen';

// The overview's band under its tab selector measured 56 dp on a 17.5 dp
// section rhythm: `RefreshProgress` is the content's first child, so the
// caller's container gap lands after it, and under reduced motion its `h-9`
// reserve is added on top of that gap whether or not a pull is in flight.
const motion = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', select: (options: Record<string, unknown>) => options.android },
  ScrollView: 'ScrollView',
  View: 'View',
  useWindowDimensions: () => ({ width: 411, height: 914, scale: 2.625, fontScale: 1 }),
}));
vi.mock('react-native-keyboard-controller', () => ({
  useKeyboardState: <T,>(selector: (state: { height: number }) => T) => selector({ height: 0 }),
}));
vi.mock('@/lib/keyboard-reveal', () => ({ scrollFocusedInputAboveKeyboard: vi.fn() }));
vi.mock('@/lib/screen-insets', () => ({
  useDetailScreenBottomPadding: () => 0,
  useScreenInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock('@/lib/a11y/motion-context', () => ({
  useProvidedMotionPolicy: () => ({
    reducedMotion: motion.reducedMotion,
    scrollAnimated: !motion.reducedMotion,
  }),
}));
vi.mock('@/components/ui/icons', () => ({ Loader2: 'Loader2' }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  motion.reducedMotion = false;
});

const refreshControl = createElement('RefreshControl', { refreshing: false });

function renderBand(props: {
  overlayRefreshProgress?: boolean;
  children?: ReactElement;
}): TestRenderer.ReactTestInstance {
  act(() => {
    renderer = TestRenderer.create(
      createElement(
        DetailScreenScrollView,
        {
          contentContainerClassName: 'gap-5 px-4 pt-3',
          refreshControl,
          ...(props.overlayRefreshProgress === undefined
            ? {}
            : { overlayRefreshProgress: props.overlayRefreshProgress }),
        },
        props.children ?? createElement('FirstBlock')
      )
    );
  });
  if (!renderer) {
    throw new Error('the scroll view did not mount');
  }
  return renderer.root.findByType('ScrollView' as ElementType);
}

describe('DetailScreenScrollView refresh band placement', () => {
  it('reserves the reduced-motion band in the content flow by default', () => {
    // Every existing caller keeps the band as a flex sibling: the container's
    // gap still follows it and its 31.5 dp reserve still pushes the content.
    motion.reducedMotion = true;
    const scroll = renderBand({});

    const first = scroll.children[0] as TestRenderer.ReactTestInstance;
    // The band is the content's first child in flow; the composite's only
    // rendered node is the reserved `h-9` View.
    expect(first.type).not.toBe('View');
    const band = first.children[0] as TestRenderer.ReactTestInstance;
    expect(band.props.className).toBe('h-9 items-center justify-center');
    expect(scroll.children[1]).toMatchObject({ type: 'FirstBlock' });
  });

  it('takes the band out of the flow when the caller overlays it', () => {
    // Out of flow, the band contributes neither a gap row nor the 31.5 dp
    // reserve, so the first child sits at the caller's own top padding in both
    // motion modes; the static spinner still paints over it during a pull.
    motion.reducedMotion = true;
    const scroll = renderBand({ overlayRefreshProgress: true });

    const overlay = scroll.children[0] as TestRenderer.ReactTestInstance;
    expect(overlay.type).toBe('View');
    expect(overlay.props.className).toBe('absolute inset-x-0 top-0');
    expect(overlay.props.pointerEvents).toBe('none');
    expect((overlay.children[0] as TestRenderer.ReactTestInstance).children[0]).toMatchObject({
      props: { className: 'h-9 items-center justify-center' },
    });
    expect(scroll.children[1]).toMatchObject({ type: 'FirstBlock' });
    expect(scroll.props.overlayRefreshProgress).toBeUndefined();
  });

  it('renders no band without a refresh control', () => {
    motion.reducedMotion = true;
    act(() => {
      renderer = TestRenderer.create(
        createElement(
          DetailScreenScrollView,
          { contentContainerClassName: 'gap-5 px-4 pt-3', overlayRefreshProgress: true },
          createElement('FirstBlock')
        )
      );
    });
    if (!renderer) {
      throw new Error('the scroll view did not mount');
    }
    const scroll = renderer.root.findByType('ScrollView' as ElementType);
    expect(scroll.children[0]).toMatchObject({ type: 'FirstBlock' });
  });
});

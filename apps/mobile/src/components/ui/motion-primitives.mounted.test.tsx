import { createElement, type ElementType } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActivityIndicator } from './activity-indicator';
import { RefreshControl } from './refresh-control';
import { RefreshProgress } from './refresh-progress';

const policy = vi.hoisted(() => ({ reducedMotion: false }));

vi.mock('react-native', () => ({
  ActivityIndicator: 'NativeActivityIndicator',
  RefreshControl: 'NativeRefreshControl',
  View: 'View',
}));
vi.mock('@/components/ui/icons', () => ({ Loader2: 'Loader2' }));
vi.mock('@/lib/a11y/motion', () => ({
  useMotionPolicy: () => ({
    reducedMotion: policy.reducedMotion,
    scrollAnimated: !policy.reducedMotion,
  }),
}));
vi.mock('@/lib/a11y/motion-context', () => ({
  useProvidedMotionPolicy: () => ({
    reducedMotion: policy.reducedMotion,
    scrollAnimated: !policy.reducedMotion,
  }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  policy.reducedMotion = false;
});

describe('motion primitives', () => {
  it('pins the static indicator wrapper to the indicator dimension', () => {
    // The wrapper owns the indicator's box under reduced motion: pinned to the
    // same dimension the native branch renders at, so wherever the indicator
    // mounts - Button's reserved busy slot included - its rendered box stays
    // visible instead of shrinking to the glyph's own measurement.
    policy.reducedMotion = true;
    const renderIndicator = (size: 'small' | 'large') =>
      createElement(ActivityIndicator, { accessibilityLabel: 'Loading', color: '#123456', size });
    act(() => {
      renderer = TestRenderer.create(createElement('Surface', null, renderIndicator('small')));
    });
    if (!renderer) {
      throw new Error('the indicator did not mount');
    }
    const mounted = renderer;
    const smallWrapper = mounted.root.find(
      node => node.type === ('View' as ElementType) && node.props.accessibilityLabel === 'Loading'
    );
    expect(smallWrapper.props.style).toEqual(expect.arrayContaining([{ width: 20, height: 20 }]));
    expect(mounted.root.findByType('Loader2' as ElementType).props).toMatchObject({
      color: '#123456',
      size: 20,
    });

    act(() => {
      mounted.update(createElement('Surface', null, renderIndicator('large')));
    });
    const largeWrapper = mounted.root.find(
      node => node.type === ('View' as ElementType) && node.props.accessibilityLabel === 'Loading'
    );
    expect(largeWrapper).toBe(smallWrapper);
    expect(largeWrapper.props.style).toEqual(expect.arrayContaining([{ width: 36, height: 36 }]));

    policy.reducedMotion = false;
    act(() => {
      mounted.update(createElement('Surface', null, renderIndicator('small')));
    });
    // The native branch passes the size through and owns the same box, so a
    // fixed-size parent (Button's reserved busy slot) cannot collapse the drawn
    // indicator to a near-zero view in flight.
    expect(mounted.root.findByType('NativeActivityIndicator' as ElementType).props).toMatchObject({
      color: '#123456',
      size: 'small',
    });
    expect(mounted.root.findByType('NativeActivityIndicator' as ElementType).props.style).toEqual(
      expect.arrayContaining([{ width: 20, height: 20 }])
    );
    act(() => {
      mounted.update(createElement('Surface', null, renderIndicator('large')));
    });
    expect(mounted.root.findByType('NativeActivityIndicator' as ElementType).props).toMatchObject({
      color: '#123456',
      size: 'large',
    });
    expect(mounted.root.findByType('NativeActivityIndicator' as ElementType).props.style).toEqual(
      expect.arrayContaining([{ width: 36, height: 36 }])
    );
    expect(
      mounted.root.findAll(
        node => node.type === ('View' as ElementType) && node.props.accessibilityLabel === 'Loading'
      )
    ).toHaveLength(0);
  });

  it('swaps native progress for fixed static progress while refresh is active', () => {
    const onRefresh = vi.fn<() => void>(() => undefined);
    const renderPrimitives = (refreshing = true) => {
      const refreshControl = createElement(RefreshControl, {
        refreshing,
        onRefresh,
        tintColor: '#654321',
      });
      return createElement(
        'Surface',
        null,
        createElement(ActivityIndicator, {
          accessibilityLabel: 'Loading sessions',
          color: '#123456',
          size: 'large',
        }),
        refreshControl,
        createElement(RefreshProgress, { refreshControl })
      );
    };

    act(() => {
      renderer = TestRenderer.create(renderPrimitives());
    });
    if (!renderer) {
      throw new Error('the motion primitives did not mount');
    }
    const mountedRenderer = renderer;
    const refreshSlot = mountedRenderer.root.find(
      node =>
        node.type === ('View' as ElementType) &&
        node.props.className === 'h-0 items-center justify-center'
    );
    expect(refreshSlot.props.accessibilityRole).toBeUndefined();

    const nativeIndicator = mountedRenderer.root.findByType(
      'NativeActivityIndicator' as ElementType
    );
    expect(nativeIndicator.props).toMatchObject({
      accessibilityLabel: 'Loading sessions',
      color: '#123456',
      size: 'large',
    });
    expect(
      mountedRenderer.root.findByType('NativeRefreshControl' as ElementType).props
    ).toMatchObject({ refreshing: true, onRefresh });
    expect(mountedRenderer.root.findAllByType('Loader2' as ElementType)).toHaveLength(0);

    policy.reducedMotion = true;
    act(() => {
      mountedRenderer.update(renderPrimitives());
    });
    expect(
      mountedRenderer.root.find(
        node =>
          node.type === ('View' as ElementType) &&
          node.props.className === 'h-9 items-center justify-center'
      )
    ).toBe(refreshSlot);
    expect(refreshSlot.props.accessibilityRole).toBe('progressbar');

    const staticIndicators = mountedRenderer.root.findAllByType('Loader2' as ElementType);
    expect(staticIndicators).toHaveLength(2);
    expect(staticIndicators[0]?.props).toMatchObject({ color: '#123456', size: 36 });
    expect(staticIndicators[1]?.props).toMatchObject({ color: '#654321', size: 20 });
    expect(
      mountedRenderer.root
        .findByType('NativeRefreshControl' as ElementType)
        .findAllByType('Loader2' as ElementType)
    ).toHaveLength(0);
    expect(
      mountedRenderer.root.findAll(
        node =>
          node.type === ('View' as ElementType) &&
          node.props.accessibilityLabel === 'Loading sessions'
      )
    ).toHaveLength(1);
    expect(
      mountedRenderer.root.findByType('NativeRefreshControl' as ElementType).props
    ).toMatchObject({ refreshing: false, onRefresh });

    act(() => {
      (
        mountedRenderer.root.findByType('NativeRefreshControl' as ElementType).props
          .onRefresh as () => void
      )();
    });
    expect(onRefresh).toHaveBeenCalledOnce();

    act(() => {
      mountedRenderer.update(renderPrimitives(false));
    });
    expect(
      mountedRenderer.root.find(
        node =>
          node.type === ('View' as ElementType) &&
          node.props.className === 'h-9 items-center justify-center'
      )
    ).toBe(refreshSlot);
    expect(refreshSlot.props.accessibilityRole).toBeUndefined();
    expect(mountedRenderer.root.findAllByType('Loader2' as ElementType)).toHaveLength(1);

    policy.reducedMotion = false;
    act(() => {
      mountedRenderer.update(renderPrimitives(false));
    });
    expect(
      mountedRenderer.root.find(
        node =>
          node.type === ('View' as ElementType) &&
          node.props.className === 'h-0 items-center justify-center'
      )
    ).toBe(refreshSlot);
    expect(refreshSlot.props.accessibilityRole).toBeUndefined();
    expect(mountedRenderer.root.findAllByType('Loader2' as ElementType)).toHaveLength(0);
  });
});

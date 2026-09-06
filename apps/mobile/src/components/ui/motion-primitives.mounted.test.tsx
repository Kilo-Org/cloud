/* eslint-disable typescript-eslint/no-deprecated -- The motion primitives need a DOM-free mounted contract test. */
import { createElement, type ElementType } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
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

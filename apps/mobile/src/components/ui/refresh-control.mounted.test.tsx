/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native regression test. */
import { createElement, type ElementType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { RefreshControl } from './refresh-control';

vi.mock('react-native', () => ({ RefreshControl: 'NativeRefreshControl' }));
vi.mock('@/lib/a11y/motion', () => ({ useMotionPolicy: () => ({ reducedMotion: false }) }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#68734A' }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('RefreshControl theme colors', () => {
  it('uses the app primary color for native refresh indicators by default', () => {
    act(() => {
      renderer = TestRenderer.create(
        createElement(RefreshControl, { refreshing: true, onRefresh: () => undefined })
      );
    });

    const native = renderer?.root.findByType('NativeRefreshControl' as ElementType);
    expect(native?.props.colors).toEqual(['#68734A']);
    expect(native?.props.tintColor).toBe('#68734A');
    expect(native?.props.refreshing).toBe(true);
  });

  it('keeps an explicitly configured native indicator color', () => {
    act(() => {
      renderer = TestRenderer.create(
        createElement(RefreshControl, {
          refreshing: true,
          onRefresh: () => undefined,
          colors: ['#123456'],
          tintColor: '#654321',
        })
      );
    });

    const native = renderer?.root.findByType('NativeRefreshControl' as ElementType);
    expect(native?.props.colors).toEqual(['#123456']);
    expect(native?.props.tintColor).toBe('#654321');
  });
});

/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native regression test. */
import { createElement, type ElementType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

import { RefreshControl } from './refresh-control';

const scheme = vi.hoisted(() => ({ current: 'light' as 'light' | 'dark' }));

vi.mock('react-native', () => ({
  RefreshControl: 'NativeRefreshControl',
  useColorScheme: () => scheme.current,
}));
vi.mock('@/lib/a11y/motion', () => ({ useMotionPolicy: () => ({ reducedMotion: false }) }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  scheme.current = 'light';
});

describe('RefreshControl theme colors', () => {
  // Android painted the pull indicator with the platform accent — a saturated
  // blue that appears nowhere in the app (device defect model-picker) — because
  // the shared wrapper forwarded no color and the screen picked none.
  it('defaults the native refresh indicator to the light muted foreground', () => {
    act(() => {
      renderer = TestRenderer.create(
        createElement(RefreshControl, { refreshing: true, onRefresh: () => undefined })
      );
    });

    const native = renderer?.root.findByType('NativeRefreshControl' as ElementType);
    expect(native?.props.colors).toEqual([lightColors.mutedForeground]);
    expect(native?.props.tintColor).toBe(lightColors.mutedForeground);
    expect(native?.props.refreshing).toBe(true);
  });

  it('follows the dark scheme with the dark muted foreground', () => {
    scheme.current = 'dark';
    act(() => {
      renderer = TestRenderer.create(
        createElement(RefreshControl, { refreshing: true, onRefresh: () => undefined })
      );
    });

    const native = renderer?.root.findByType('NativeRefreshControl' as ElementType);
    expect(native?.props.colors).toEqual([darkColors.mutedForeground]);
    expect(native?.props.tintColor).toBe(darkColors.mutedForeground);
  });

  it('keeps a color the screen configured itself', () => {
    scheme.current = 'dark';
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

/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native regression test. */
import { createElement, type ElementType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { darkColors } from '@/lib/hooks/theme-colors.generated';

import { RefreshControl } from './refresh-control';

vi.mock('react-native', () => ({ RefreshControl: 'NativeRefreshControl' }));
vi.mock('@/lib/a11y/motion', () => ({ useMotionPolicy: () => ({ reducedMotion: false }) }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('RefreshControl theme colors', () => {
  // Android painted the pull indicator with the platform accent — a saturated
  // blue that appears nowhere in the app (device defect model-picker) — because
  // the shared wrapper forwarded no color and the screen picked none.
  it('defaults the native refresh indicator to the app muted foreground', () => {
    act(() => {
      renderer = TestRenderer.create(
        createElement(RefreshControl, { refreshing: true, onRefresh: () => undefined })
      );
    });

    const native = renderer?.root.findByType('NativeRefreshControl' as ElementType);
    expect(native?.props.colors).toEqual([darkColors.mutedForeground]);
    expect(native?.props.tintColor).toBe(darkColors.mutedForeground);
    expect(native?.props.refreshing).toBe(true);
  });

  it('keeps a color the screen configured itself', () => {
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

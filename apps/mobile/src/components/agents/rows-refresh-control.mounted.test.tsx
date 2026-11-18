import { createElement, type ElementType, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RowsRefreshControl } from './rows-refresh-control';

const platform = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));
const WINDOW_HEIGHT = 844;

vi.mock('react-native', () => ({
  Platform: platform,
  useWindowDimensions: () => ({ height: WINDOW_HEIGHT }),
}));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  platform.OS = 'android';
});

function propOf(instance: TestRenderer.ReactTestInstance | undefined, key: string): unknown {
  if (!instance) {
    return undefined;
  }
  /* eslint-disable typescript-eslint/no-unsafe-member-access -- renderer props are an index signature */
  return instance.props[key];
  /* eslint-enable typescript-eslint/no-unsafe-member-access */
}

/** Mounts the control and returns the native `RefreshControl` it renders. */
function mountRowsControl({
  refreshing,
  onRefresh = vi.fn<() => void>(() => undefined),
  scrollable,
}: {
  refreshing: boolean;
  onRefresh?: () => void;
  scrollable?: { style: { flex: number }; children: ReactNode };
}): { control: TestRenderer.ReactTestInstance; onRefresh: () => void } {
  act(() => {
    renderer = TestRenderer.create(
      createElement(RowsRefreshControl, { refreshing, onRefresh, ...scrollable })
    );
  });
  if (!renderer) {
    throw new Error('the rows refresh control did not mount');
  }
  return { control: renderer.root.findByType('RefreshControl' as ElementType), onRefresh };
}

describe('RowsRefreshControl', () => {
  it('parks the Android disc a whole viewport below the top, clearing the first row', () => {
    // The platform disc floats over the first row — the whole reason it may not
    // draw there (device defect uxs1). A viewport-tall offset puts it past the
    // bottom of a list that fills a window.
    const { control } = mountRowsControl({ refreshing: true });

    expect(propOf(control, 'refreshing')).toBe(true);
    expect(propOf(control, 'progressViewOffset')).toBe(WINDOW_HEIGHT);
  });

  it('leaves the platform control enabled, so the pull gesture still reaches onRefresh', () => {
    const { control, onRefresh } = mountRowsControl({ refreshing: false });

    expect(propOf(control, 'enabled')).toBeUndefined();
    (propOf(control, 'onRefresh') as () => void)();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('wraps the scrollable Android hands it, so the list itself still mounts', () => {
    // Android's ScrollView clones the control with the ScrollView as its
    // children and its layout style. Dropping either one unmounts the whole
    // list: the control owns the scrollable, not just the indicator.
    const style = { flex: 1 };
    const { control } = mountRowsControl({
      refreshing: false,
      scrollable: { style, children: createElement('RowsContent') },
    });

    expect(propOf(control, 'style')).toBe(style);
    expect((propOf(control, 'children') as { type: unknown }).type).toBe('RowsContent');
  });

  it('leaves iOS on the platform indicator, which is inset and cannot cover a row', () => {
    platform.OS = 'ios';
    const { control, onRefresh } = mountRowsControl({ refreshing: true });

    expect(propOf(control, 'refreshing')).toBe(true);
    expect(propOf(control, 'progressViewOffset')).toBeUndefined();
    (propOf(control, 'onRefresh') as () => void)();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

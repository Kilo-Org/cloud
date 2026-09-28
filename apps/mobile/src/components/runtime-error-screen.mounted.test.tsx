import { type ComponentPropsWithRef, createElement, useImperativeHandle } from 'react';
import { type ScrollView } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import { RuntimeErrorScreen } from './runtime-error-screen';
import { AlertCircle } from './ui/icons';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

// The device's native surface observer has not published a usable geometry for
// the just-mounted error surface (the Android module reports a surface it
// cannot see as `visibleTop === visibleBottom`; a pending observation reports
// nothing at all). Under that snapshot the measured centering pipeline has no
// frame and withholds everything it owns. The runtime-error screen must paint
// regardless.
const geometry = vi.hoisted(() => ({
  status: 'ready' as const,
  geometry: {
    tag: 41,
    visibleTop: 0,
    visibleBottom: 0,
    boundsHeight: 800,
    safeAreaTop: 0,
    safeAreaBottom: 0,
  },
}));
vi.mock('@/lib/hooks/use-native-state-geometry', () => ({
  useNativeStateGeometry: () => geometry,
}));

vi.mock('react-native', () => ({
  PixelRatio: { roundToNearestPixel: (value: number) => Math.round(value * 2) / 2 },
  Platform: { OS: 'android' },
  useWindowDimensions: () => ({ width: 400, height: 800 }),
  View: 'View',
  ScrollView: (props: ComponentPropsWithRef<typeof ScrollView>) => {
    const { ref, ...rest } = props;
    useImperativeHandle(
      ref,
      () =>
        ({
          getNativeScrollRef: () => ({ measureInWindow: () => undefined }),
        }) as unknown as ScrollView,
      []
    );
    return createElement('ScrollView', rest);
  },
}));

vi.mock('@/lib/utils', () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: () => null,
  Loader2: () => null,
  Lock: () => null,
  SearchX: () => null,
  ServerCrash: () => null,
  WifiOff: () => null,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#777777' }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// ── Helpers ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('RuntimeErrorScreen', () => {
  it('paints its message, description and next action with no usable surface geometry', async () => {
    const onRetry = vi.fn<() => void>();
    const mounted = await renderWithProviders(<RuntimeErrorScreen onRetry={onRetry} />);

    // Nothing may be withheld: the centering pipeline hides its content with
    // `accessibilityElementsHidden` + `opacity-0` until it has measured, which
    // is the blank frame this screen must never show.
    const hidden = mounted.renderer.root.findAll(
      node => node.props.accessibilityElementsHidden === true
    );
    expect(hidden).toHaveLength(0);

    const labels = mounted.renderer.root
      .findAll(node => typeof node.props.children === 'string')
      .map(node => node.props.children as string);
    expect(labels).toContain('common.somethingWentWrong');
    expect(labels).toContain('common.retry');

    // The failure icon and the description are the designed error body.
    expect(mounted.renderer.root.findAllByType(AlertCircle)).toHaveLength(1);
    expect(
      mounted.renderer.root.findAll(node => node.props.message === 'queryError.neutralDescription')
    ).toHaveLength(1);

    const retry = mounted.renderer.root.findAll(
      node => node.props.accessibilityLabel === 'common.retry'
    );
    expect(retry).toHaveLength(1);
    const retryButton = retry[0];
    if (!retryButton) {
      throw new TypeError('Expected a retry control');
    }
    (retryButton.props.onPress as () => void)();
    expect(onRetry).toHaveBeenCalledOnce();

    mounted.unmount();
  });
});

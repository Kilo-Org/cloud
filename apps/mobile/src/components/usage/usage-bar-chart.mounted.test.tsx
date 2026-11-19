// The chart's bars and its date row must name the same day. The date row is a
// flex row, so a right-to-left layout lays the oldest date at the right; the SVG
// never mirrors, so the bars carry the mirror themselves.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UsageBarChart } from './usage-bar-chart';

const layoutDirection = vi.hoisted(() => ({ isRTL: false }));

const themeState = vi.hoisted(() => ({ scheme: 'light' as 'light' | 'dark' }));

vi.mock('react-native', () => ({
  I18nManager: layoutDirection,
  View: 'View',
  useColorScheme: () => themeState.scheme,
}));
vi.mock('react-native-svg', () => ({ Rect: 'Rect', default: 'Svg' }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/format', () => ({ formatCalendarDate: (value: string) => value }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#101010', selection: '#202020', ringTrack: '#909090' }),
}));

const POINTS = [
  { datetime: '2026-11-14', value: 1 },
  { datetime: '2026-11-15', value: 2 },
  { datetime: '2026-11-16', value: 4 },
];
const VIEW_BOX = 100;
const STEP = VIEW_BOX / POINTS.length;
const BAR_WIDTH = STEP * 0.64;

async function mount(): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(() => {
    rendererRef.current = TestRenderer.create(
      createElement(UsageBarChart, { points: POINTS, accessibilityLabel: 'Usage' })
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

/** Every painted bar's x, oldest first; the full-width baseline is not a bar. */
function xs(renderer: TestRenderer.ReactTestRenderer): number[] {
  return renderer.root
    .findAllByType('Rect')
    .filter(rect => Number(rect.props.width) < VIEW_BOX)
    .map(rect => Number(rect.props.x));
}

afterEach(() => {
  layoutDirection.isRTL = false;
  themeState.scheme = 'light';
});

/** Every bar's fill; the full-width baseline is not a bar. */
function barFills(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType('Rect')
    .filter(rect => Number(rect.props.width) < VIEW_BOX)
    .map(rect => String(rect.props.fill));
}

describe('UsageBarChart bar color', () => {
  it('paints the bars with the primary token in light mode', async () => {
    themeState.scheme = 'light';

    expect(barFills(await mount())).toEqual(['#101010', '#101010', '#101010']);
  });

  it('paints the bars with the selection token in dark mode', async () => {
    themeState.scheme = 'dark';

    expect(barFills(await mount())).toEqual(['#202020', '#202020', '#202020']);
  });
});

describe('UsageBarChart bar direction', () => {
  it('puts the oldest bar at the left edge in a left-to-right layout', async () => {
    layoutDirection.isRTL = false;
    const [first, , last] = xs(await mount());

    expect(first).toBeCloseTo((STEP - BAR_WIDTH) / 2, 5);
    expect(last).toBeCloseTo(VIEW_BOX - STEP + (STEP - BAR_WIDTH) / 2, 5);
  });

  it('puts the oldest bar at the right edge in a right-to-left layout', async () => {
    layoutDirection.isRTL = true;
    const [first, , last] = xs(await mount());

    expect(first).toBeCloseTo(VIEW_BOX - STEP + (STEP - BAR_WIDTH) / 2, 5);
    expect(last).toBeCloseTo((STEP - BAR_WIDTH) / 2, 5);
  });

  it('mirrors every bar across the plot and keeps it inside the view box', async () => {
    layoutDirection.isRTL = false;
    const leftToRight = xs(await mount());
    layoutDirection.isRTL = true;
    const rightToLeft = xs(await mount());

    expect(rightToLeft).toHaveLength(leftToRight.length);
    for (const [index, x] of leftToRight.entries()) {
      expect(rightToLeft[index]).toBeCloseTo(VIEW_BOX - x - BAR_WIDTH, 5);
      expect(rightToLeft[index]).toBeGreaterThanOrEqual(0);
      expect((rightToLeft[index] ?? 0) + BAR_WIDTH).toBeLessThanOrEqual(VIEW_BOX);
    }
  });
});

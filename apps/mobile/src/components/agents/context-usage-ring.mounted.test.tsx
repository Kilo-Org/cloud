import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { ContextUsageRing } from './context-usage-ring';

vi.mock('react-native-svg', () => ({ Circle: 'Circle', default: 'Svg' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primary: '#101010',
    warn: '#303030',
    destructive: '#505050',
    mutedForeground: '#707070',
    ringTrack: '#909090',
  }),
}));

const SIZE = 28;
const STROKE = 3;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

async function mount(arcFraction: number | undefined): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(() => {
    rendererRef.current = TestRenderer.create(
      createElement(ContextUsageRing, { arcFraction, tone: 'neutral' })
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function circles(renderer: TestRenderer.ReactTestRenderer): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAllByType('Circle');
}

/** The arc circle's dash length, from `strokeDasharray="<dash> <gap>"`. */
function arcDashLength(renderer: TestRenderer.ReactTestRenderer): number {
  const arc = circles(renderer)[1];
  if (!arc) {
    throw new Error('the arc circle was not painted');
  }
  const [dash] = String(arc.props.strokeDasharray).split(' ');
  return Number(dash);
}

describe('ContextUsageRing', () => {
  it('paints the track plus a half-circumference arc for a known half share', async () => {
    const renderer = await mount(0.5);

    expect(circles(renderer)).toHaveLength(2);
    expect(arcDashLength(renderer)).toBeCloseTo(CIRCUMFERENCE / 2, 5);
  });

  it('paints the track alone when the capacity is unknown', async () => {
    const renderer = await mount(undefined);

    expect(circles(renderer)).toHaveLength(1);
  });

  it('paints the track alone for a settled zero share, so no round-cap dot is drawn', async () => {
    const renderer = await mount(0);

    expect(circles(renderer)).toHaveLength(1);
  });

  it('paints the full circumference for a saturated share', async () => {
    const renderer = await mount(1);

    expect(circles(renderer)).toHaveLength(2);
    expect(arcDashLength(renderer)).toBeCloseTo(CIRCUMFERENCE, 5);
  });
});

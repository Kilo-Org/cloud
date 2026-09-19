import * as React from 'react';

import { describe, expect, it, vi } from 'vitest';

import { ContextUsageRing } from './context-usage-ring';

vi.mock('react-native-svg', () => ({ Circle: 'Circle', default: 'Svg' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    destructive: '#cc0000',
    hairSoft: '#eeeeee',
    mutedForeground: '#666666',
    primary: '#111111',
    warn: '#aa8800',
  }),
}));

function render(props: React.ComponentProps<typeof ContextUsageRing>): React.ReactElement {
  // eslint-disable-next-line new-cap
  return ContextUsageRing(props) as React.ReactElement;
}

function findAll(
  node: unknown,
  predicate: (el: React.ReactElement) => boolean
): React.ReactElement[] {
  const matches: React.ReactElement[] = [];

  function walk(value: unknown): void {
    if (value == null || typeof value === 'string' || typeof value === 'number') {
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) {
        walk(child);
      }
      return;
    }
    if (React.isValidElement(value)) {
      if (predicate(value)) {
        matches.push(value);
      }
      walk((value.props as { children?: unknown }).children);
    }
  }

  walk(node);
  return matches;
}

function circles(root: React.ReactElement): React.ReactElement[] {
  return findAll(root, el => el.type === 'Circle');
}

describe('ContextUsageRing', () => {
  // Regression: a zero-length dash with `strokeLinecap="round"` paints a dot at
  // 12 o'clock. In the session header's empty loading pill that dot is a top
  // spinner, duplicating the full-page skeleton the open is supposed to show.
  it('paints only the track when there is no usage to show', () => {
    const found = circles(render({ arcFraction: 0, tone: 'neutral' }));
    const track = found[0];

    expect(found).toHaveLength(1);
    expect(track).toBeDefined();
    if (track == null) {
      throw new Error('expected the track circle');
    }
    expect((track.props as { stroke?: string }).stroke).toBe('#eeeeee');
  });

  it('paints the track and the arc for a known fraction', () => {
    const found = circles(render({ arcFraction: 0.25, tone: 'primary' }));
    const arcElement = found[1];

    expect(found).toHaveLength(2);
    expect(arcElement).toBeDefined();
    if (arcElement == null) {
      throw new Error('expected the arc circle');
    }
    const arc = arcElement.props as { strokeDasharray?: string; strokeLinecap?: string };
    expect(arc.strokeLinecap).toBe('round');
    expect(arc.strokeDasharray?.startsWith('19.6') ?? false).toBe(true);
  });

  it('paints an indeterminate arc when the fraction is unknown', () => {
    const found = circles(render({ arcFraction: undefined, tone: 'neutral' }));

    expect(found).toHaveLength(2);
  });
});

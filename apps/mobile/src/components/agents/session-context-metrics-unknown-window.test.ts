import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { findAll, info, render } from './session-context-metrics-test-helpers';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./context-usage-ring', () => ({ ContextUsageRing: 'ContextUsageRing' }));

const classOf = (el: React.ReactElement): string => {
  const props: unknown = el.props;
  if (props !== null && typeof props === 'object' && 'className' in props) {
    const { className } = props;
    return typeof className === 'string' ? className : '';
  }
  return '';
};

const childrenOf = (el: React.ReactElement): unknown => {
  const props: unknown = el.props;
  if (props !== null && typeof props === 'object' && 'children' in props) {
    return props.children;
  }
  return undefined;
};

const hiddenForAccessibility = (el: React.ReactElement): boolean => {
  const props: unknown = el.props;
  return props !== null && typeof props === 'object' && 'accessibilityElementsHidden' in props;
};

describe('SessionContextMetrics unknown context window', () => {
  // A session that reports tokens but no context window has no percentage. The
  // percentage slot sits immediately before the cost, so a marker painted there
  // read as a minus sign in front of the price. The slot keeps the width of the
  // marker and paints nothing.
  it('paints no marker before the cost when the window is unknown', () => {
    const unknownWindow = info({ contextWindow: undefined, percentage: undefined });
    const root = render({
      hasMessages: true,
      info: unknownWindow,
      totalCostMicrodollars: 20_000,
    });

    const texts = findAll(root, el => el.type === 'Text');
    const reserved = texts.filter(el => classOf(el).includes('opacity-0'));
    expect(reserved).toHaveLength(1);
    const reservedSlot = reserved[0];
    if (reservedSlot === undefined) {
      throw new Error('expected the reserved percentage slot');
    }
    // The slot holds the marker's own width, so nothing shifts when the window
    // later resolves and the slot paints a percentage instead.
    expect(childrenOf(reservedSlot)).toBe('—');
    expect(hiddenForAccessibility(reservedSlot)).toBe(true);

    const visible = texts.filter(el => !classOf(el).includes('opacity-0'));
    expect(visible).toHaveLength(1);
    const cost = visible[0];
    if (cost === undefined) {
      throw new Error('expected the cost text');
    }
    expect(String(childrenOf(cost))).toContain('$0.02');
  });

  it('paints nothing at all beside the ring when the window and the cost are unknown', () => {
    const root = render({
      hasMessages: true,
      info: info({ contextWindow: undefined, percentage: undefined }),
      totalCostMicrodollars: null,
    });
    const texts = findAll(root, el => el.type === 'Text');
    expect(texts).toHaveLength(1);
    expect(classOf(texts[0] ?? root)).toContain('opacity-0');
  });

  // The marker keeps painting where it is the only value: a session that has
  // reported nothing yet still shows both slots, so a settled pill fills the
  // slots it already showed.
  it('still paints the placeholder marker on a session that reports nothing', () => {
    const root = render({
      hasMessages: false,
      info: undefined,
      totalCostMicrodollars: null,
    });
    const texts = findAll(root, el => el.type === 'Text');
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(childrenOf(text)).toBe('—');
      expect(classOf(text)).not.toContain('opacity-0');
    }
  });
});

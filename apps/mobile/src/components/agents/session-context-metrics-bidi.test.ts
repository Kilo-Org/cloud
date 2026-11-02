import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { findAll, info, render } from './session-context-metrics-test-helpers';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./context-usage-ring', () => ({ ContextUsageRing: 'ContextUsageRing' }));

/** A text host's `children`, which React 19 types as `unknown`. */
function textChildren(el: React.ReactElement): unknown {
  const props: unknown = el.props;
  if (props !== null && typeof props === 'object' && 'children' in props) {
    return props.children;
  }
  return undefined;
}

describe('SessionContextMetrics cost direction', () => {
  // The pill puts the percentage and the session cost beside each other. In a
  // right-to-left interface the currency sign is a neutral character, so an
  // unisolated run reorders around the percentage: `$ 0.0005` instead of
  // `$0.0005`. The cost is a value read left to right, so it is pinned as one.
  it('pins the cost run left to right so the currency sign stays with its amount', () => {
    const root = render({
      hasMessages: true,
      info: info({ percentage: 5 }),
      totalCostMicrodollars: 500,
    });
    const costText = findAll(root, el => el.type === 'Text').find(el => {
      const children = textChildren(el);
      return typeof children === 'string' && children.includes('0.0005');
    });
    expect(costText).toBeDefined();
    if (costText === undefined) {
      throw new Error('expected the cost text');
    }
    expect(textChildren(costText)).toBe('\u2066$0.0005\u2069');
  });
});

import { type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SegmentedControl } from './segmented-control';

// The node project never parses RN's Flow-typed sources, so the primitives the
// control composes become string elements (same pattern as radio-group.test.ts).
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

type ElementNode = { type?: unknown; props?: Record<string, unknown> };

function collectByType(node: unknown, typeName: string, found: ElementNode[] = []): ElementNode[] {
  if (node === null || typeof node !== 'object') {
    return found;
  }
  const element = node as ElementNode;
  if (element.type === typeName) {
    found.push(element);
  }
  const children = element.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    collectByType(child, typeName, found);
  }
  return found;
}

function noopOnChange(value: string): void {
  void value;
}

describe('SegmentedControl', () => {
  // Regression: the period control on the spend-alerts screen rendered the Hindi
  // option "7 दिन" as "7". The label was pinned to one line with
  // `adjustsFontSizeToFit`, and a label that the font shrink could not fit was
  // cut with no ellipsis. Every option must keep its full label: no line cap, no
  // font shrink, and a segment that lets the label wrap instead of clipping it.
  it('never truncates or shrinks an option label', () => {
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = SegmentedControl({
      accessibilityLabel: 'Changes',
      options: [
        { value: 'leave', label: 'Leave changes' },
        { value: 'commit', label: 'Commit and push' },
      ],
      value: 'leave',
      onChange: noopOnChange,
    }) as ReactElement;

    const labels = collectByType(element, 'Text');
    expect(labels.map(label => label.props?.children)).toEqual([
      'Leave changes',
      'Commit and push',
    ]);
    for (const label of labels) {
      expect(label.props?.numberOfLines).toBeUndefined();
      expect(label.props?.adjustsFontSizeToFit).toBeFalsy();
    }

    // A centred Text child is sized to its content, so a long label would
    // overflow its segment instead of wrapping onto a second line.
    for (const segment of collectByType(element, 'Pressable')) {
      expect(String(segment.props?.className)).not.toContain('items-center');
    }
  });
});

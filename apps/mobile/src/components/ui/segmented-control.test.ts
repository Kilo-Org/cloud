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
  // Regression: "Commit and push" is wider than "Leave changes", so a wrapping
  // label made the two segments render at unequal height and weight (new-task
  // "Changes" control, 720x1600). Every label must stay on one line; the
  // platform shrinks the font to fit instead of wrapping.
  it('keeps every segment label on a single line', () => {
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
      expect(label.props?.numberOfLines).toBe(1);
      expect(label.props?.adjustsFontSizeToFit).toBe(true);
    }
  });
});

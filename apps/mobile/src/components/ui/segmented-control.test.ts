import { type ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';

import {
  SEGMENTED_FRAME_CLASS,
  SEGMENTED_FRAME_HEIGHT,
  SEGMENTED_FRAME_HEIGHT_CLASS,
  SegmentedControl,
} from './segmented-control';

// The node project never parses RN's Flow-typed sources, so the primitives the
// control composes become string elements (same pattern as radio-group.test.ts).
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
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

  // A skeleton that stands in for a loading control has to reserve the loaded
  // frame, or the screen shifts when the control arrives. The frame and its
  // height come from here, not from a hand-sized box at the call site.
  it('exports the track it draws and the box a skeleton reserves', () => {
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = SegmentedControl({
      accessibilityLabel: 'Period',
      options: [{ value: '24', label: '24 hours' }],
      value: '24',
      onChange: noopOnChange,
    }) as ReactElement;

    expect((element as unknown as ElementNode).props?.className).toBe(SEGMENTED_FRAME_CLASS);
    expect(SEGMENTED_FRAME_CLASS).toContain('p-1');

    const segmentFloor = Number(/min-h-\[(\d+)px\]/.exec(ROW_TARGET_CLASS)?.[1]);
    // 3.5pt above and below the segment at the track's `p-1`.
    expect(SEGMENTED_FRAME_HEIGHT).toBe(segmentFloor + 7);
    expect(SEGMENTED_FRAME_HEIGHT_CLASS).toBe(`min-h-[${SEGMENTED_FRAME_HEIGHT}px]`);
  });

  it('carries a segment test id and fixes only the choice it marks', () => {
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = SegmentedControl({
      accessibilityLabel: 'Window',
      options: [
        { value: 'plan', label: 'Plan default', disabled: true },
        { value: 'custom', label: 'Custom', testID: 'window-custom' },
      ],
      value: 'custom',
      onChange: noopOnChange,
    }) as ReactElement;

    const segments = collectByType(element, 'Pressable');
    expect(segments[0]?.props?.disabled).toBe(true);
    expect(segments[0]?.props?.accessibilityState).toEqual({
      busy: false,
      checked: false,
      disabled: true,
    });
    expect(segments[0]?.props?.testID).toBeUndefined();

    expect(segments[1]?.props?.testID).toBe('window-custom');
    expect(segments[1]?.props?.disabled).toBe(false);
    expect(segments[1]?.props?.accessibilityState).toEqual({
      busy: false,
      checked: true,
      disabled: false,
    });
  });

  // A segment can carry a mark (a count, a status dot). It rides the label's
  // line, and the label shrinks into the width left over, so a long label still
  // wraps instead of pushing the mark out of the segment.
  it('renders a badge after the label and lets the label shrink', () => {
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = SegmentedControl({
      accessibilityLabel: 'Findings',
      options: [{ value: 'open', label: 'Open findings', badge: '3' }],
      value: 'open',
      onChange: noopOnChange,
    }) as ReactElement;

    const [segment] = collectByType(element, 'Pressable');
    const [row] = collectByType(segment?.props?.children, 'View');
    expect(String(row?.props?.className)).toContain('flex-row');
    expect(String(row?.props?.className)).toContain('items-center');

    const children = row?.props?.children as unknown[];
    expect(collectByType(children[0], 'Text')[0]?.props?.children).toBe('Open findings');
    expect(children[1]).toBe('3');

    const [label] = collectByType(children[0], 'Text');
    expect(String(label?.props?.className)).toContain('shrink');
  });

  it('keeps a badge-less label as the segment child', () => {
    // eslint-disable-next-line new-cap -- plain function call, matching repo test convention
    const element = SegmentedControl({
      accessibilityLabel: 'Findings',
      options: [{ value: 'open', label: 'Open findings' }],
      value: 'open',
      onChange: noopOnChange,
    }) as ReactElement;

    const [segment] = collectByType(element, 'Pressable');
    // One child expression, so React hands the element itself instead of a list.
    const rendered = segment?.props?.children as ElementNode | ElementNode[];
    const children = Array.isArray(rendered) ? rendered : [rendered];
    expect(children).toHaveLength(1);
    expect(children[0]?.type).toBe('Text');
    expect(String(children[0]?.props?.className)).not.toContain('shrink');
  });
});

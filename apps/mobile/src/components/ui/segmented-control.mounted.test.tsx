/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement, type ElementType } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { SegmentedControl } from './segmented-control';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderControl() {
  act(() => {
    const element = createElement(SegmentedControl<string>, {
      accessibilityLabel: 'Changes',
      options: [
        { value: 'leave', label: 'Leave changes' },
        { value: 'commit', label: 'Commit and push' },
      ],
      value: 'leave',
      onChange: () => undefined,
    });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing SegmentedControl renderer');
  }
  return renderer.root;
}

/** The label Text for one option, identified by its rendered string. */
function labelText(root: TestRenderer.ReactTestInstance, label: string) {
  return root.find(node => Object.is(node.type, 'Text') && node.children.includes(label));
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('SegmentedControl mounted layout', () => {
  // Regression: the spend-alerts period control rendered the Hindi option
  // "7 दिन" as "7" — the label was clamped to one line with a font shrink that
  // clipped instead of ellipsizing. Equal-width segments are narrow, so the
  // label must be free to wrap to as many lines as it needs, never cut.
  it('leaves every option label uncapped so the full text always shows', () => {
    const root = renderControl();
    expect(labelText(root, 'Leave changes').props.numberOfLines).toBeUndefined();
    expect(labelText(root, 'Commit and push').props.numberOfLines).toBeUndefined();
    expect(labelText(root, 'Commit and push').props.adjustsFontSizeToFit).toBeFalsy();
  });

  // `items-center` on the segment sizes the Text to its content, which clips a
  // long label instead of wrapping it; `py-2` keeps a two-line label inset.
  it('stretches the label across the segment and insets wrapped lines', () => {
    const options = renderControl().findAllByType('Pressable' as ElementType);
    expect(options).toHaveLength(2);
    for (const option of options) {
      const className = String(option.props.className);
      expect(className).not.toContain('items-center');
      expect(className).toContain('py-2');
    }
  });
});

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
  // Equal-width segments are narrow on a phone, so the longest reference label
  // ("Commit and push") wrapped to two lines while "Leave changes" stayed on
  // one, leaving the two choices uneven (SPOT-DEFECT: the Changes control on
  // the session-create-failed screen).
  it('clamps every option label to one line so the choices stay even', () => {
    const root = renderControl();
    expect(labelText(root, 'Leave changes').props.numberOfLines).toBe(1);
    expect(labelText(root, 'Commit and push').props.numberOfLines).toBe(1);
  });

  it('insets each segment by px-2 so the reference label fits without wrapping', () => {
    const options = renderControl().findAllByType('Pressable' as ElementType);
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(String(option.props.className)).toContain('px-2');
    }
  });
});

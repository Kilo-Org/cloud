/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { TabBarLabel } from './tab-bar-label';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Text: 'Text',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderLabel(label: string, focused = false) {
  act(() => {
    const element = createElement(TabBarLabel, { label, focused });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing TabBarLabel renderer');
  }
  return renderer.root;
}

function labelText(root: TestRenderer.ReactTestInstance, label: string) {
  return root.find(node => Object.is(node.type, 'Text') && node.children.includes(label));
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('TabBarLabel mounted layout', () => {
  // 155c33b5: a tab narrower than its label wrapped the single word mid-word
  // (e.g. "Hom\ne"), leaving the bar unreadable. Every label the copy does not
  // break itself now stays on one line and truncates at the tail.
  it('keeps a fitting single-word label on one line', () => {
    const text = labelText(renderLabel('Profile'), 'Profile');
    expect(text.props.numberOfLines).toBe(1);
    expect(text.props.ellipsizeMode).toBe('tail');
  });

  it('keeps a word wider than its tab on one line with a tail ellipsis', () => {
    const text = labelText(renderLabel('Conversazioni'), 'Conversazioni');
    expect(text.props.numberOfLines).toBe(1);
    expect(text.props.ellipsizeMode).toBe('tail');
  });

  it('keeps the two lines only for copy that carries its own break', () => {
    const text = labelText(renderLabel('Kilo\nClaw'), 'Kilo\nClaw');
    expect(text.props.numberOfLines).toBe(2);
  });

  it('leaves the announced tab name to the tab button', () => {
    const text = labelText(renderLabel('Home'), 'Home');
    expect(text.props.accessible).toBe(false);
  });
});

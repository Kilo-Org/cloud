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

  // Refutes explorer findings 2 (account.png, dark) and 4 (preferences.png,
  // light), both claiming the focused Profile label is the palest, lowest
  // contrast text in the bar and reads as disabled. The captures show the
  // opposite: in light mode the focused PROFILE label's darkest glyph pixel is
  // 0 with a mean of 56, against 89 and 112 for unfocused HOME and AGENTS; in
  // dark mode PROFILE is the only label at full white (255), with HOME and
  // AGENTS around 149. tab-bar-label.tsx:15-19 and (tabs)/_layout.tsx:129-130
  // set exactly this pair, so the polarity is the contract a future edit must
  // keep: focused is text-foreground, unfocused is text-muted-foreground.
  it('paints the focused label with the foreground token', () => {
    const text = labelText(renderLabel('Profile', true), 'Profile');
    expect(text.props.className).toContain('text-foreground');
    expect(text.props.className).not.toContain('text-muted-foreground');
  });

  it('paints the unfocused label with the muted-foreground token', () => {
    const text = labelText(renderLabel('Profile', false), 'Profile');
    expect(text.props.className).toContain('text-muted-foreground');
    expect(text.props.className).not.toContain('text-foreground');
  });
});

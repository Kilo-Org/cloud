/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';

import { PillGroup } from './settings-pill-group';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ primary: '#111111' }),
}));

const OPTIONS = [
  { value: 'severe', label: 'Severe' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
] as const;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderGroup() {
  act(() => {
    const element = createElement(PillGroup, {
      label: 'Minimum severity',
      options: OPTIONS,
      value: 'high',
      disabled: false,
      onChange: () => undefined,
    });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing PillGroup renderer');
  }
  return renderer.root;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('PillGroup touch target', () => {
  // Regression: a picker row sized by its one label line rendered 38.5 dp in
  // this app's rem and carried no floor, so adjacent severity options sat under
  // the design target with no gap between their tap areas. The floor has to be
  // the row node's own class; `hitSlop` would not move the rect a control-size
  // audit measures.
  it('carries the shared row floor on every option row', () => {
    const rows = renderGroup().findAll(node => Object.is(node.type, 'Pressable'));

    expect(rows).toHaveLength(OPTIONS.length);
    for (const row of rows) {
      expect(String(row.props.className).split(' ')).toContain(ROW_TARGET_CLASS);
      expect(row.props.hitSlop).toBeUndefined();
    }
  });
});

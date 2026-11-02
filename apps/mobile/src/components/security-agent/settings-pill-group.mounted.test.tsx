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
  useThemeColors: () => ({ primary: '#111111', mutedForeground: '#222222' }),
}));

const OPTIONS = [
  { value: 'severe', label: 'Severe' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
] as const;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderGroup(disabled = false) {
  act(() => {
    const element = createElement(PillGroup, {
      label: 'Minimum severity',
      options: OPTIONS,
      value: 'high',
      disabled,
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

describe('PillGroup disabled cue', () => {
  // Regression: a disabled group halved the whole option row on top of the
  // muted label, which lands the text near 2:1 on the row's `secondary` surface
  // in both schemes — under the 4.5:1 text floor, so a member who cannot manage
  // the setting could not read which option was set. The cue is the muted
  // token, applied once; no row carries a second dim on top of it.
  it('dims a read-only group by token, never by row opacity', () => {
    const rows = renderGroup(true).findAll(node => Object.is(node.type, 'Pressable'));

    expect(rows).toHaveLength(OPTIONS.length);
    for (const row of rows) {
      const tokens = String(row.props.className).split(/\s+/);
      expect(tokens).toContain('active:opacity-70');
      expect(tokens).not.toContain('opacity-50');
    }
  });

  // Regression: a read-only list once kept its selected label on the full
  // `foreground` ink, so the brightest line in a group the member cannot change
  // was the option itself and the list read as editable. Every label of a
  // read-only group sits on the muted token; the selected row keeps only its
  // weight and its check to say which option is set.
  it('dims every read-only label, the selected one included', () => {
    const labels = renderGroup(true).findAll(node => Object.is(node.type, 'Text'));
    const byText = new Map(labels.map(label => [String(label.props.children), label]));

    for (const option of ['Severe', 'High', 'Medium', 'Low']) {
      const tokens = String(byText.get(option)?.props.className).split(/\s+/);
      expect(tokens).toContain('text-muted-foreground');
      expect(tokens).not.toContain('text-foreground');
    }
    const selected = String(byText.get('High')?.props.className).split(/\s+/);
    expect(selected).toContain('font-medium');
  });

  it('mutes the check of a read-only group off the accent', () => {
    const [check] = renderGroup(true).findAll(node => Object.is(node.type, 'Check'));

    expect(check?.props.color).toBe('#222222');
  });

  it('keeps an editable group on the full-strength selected label and accent', () => {
    const [label] = renderGroup(false).findAll(
      node => Object.is(node.type, 'Text') && Object.is(node.props.children, 'High')
    );
    const [check] = renderGroup(false).findAll(node => Object.is(node.type, 'Check'));

    expect(String(label?.props.className).split(/\s+/)).toContain('text-foreground');
    expect(check?.props.color).toBe('#111111');
  });
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

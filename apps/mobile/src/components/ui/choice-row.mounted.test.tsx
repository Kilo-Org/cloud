/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';

import { ChoiceRow } from './choice-row';

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('@/components/ui/icons', () => ({ Check: 'Check' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: '#111111' }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

type RowProps = {
  label?: string;
  description?: string;
  accessibleName?: string;
  selected: boolean;
  busy?: boolean;
  multi?: boolean;
  disabled?: boolean;
  children?: ReactNode;
};

function renderRow(props: RowProps) {
  act(() => {
    const element = createElement(ChoiceRow, { onPress: () => undefined, ...props });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing ChoiceRow renderer');
  }
  return renderer.root;
}

/** The one control the row exposes; the check glyph and the copy are children of it. */
function rowControl(root: TestRenderer.ReactTestInstance) {
  return root.find(node => Object.is(node.type, 'Pressable'));
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ChoiceRow accessible name', () => {
  it('names a row after its label alone when it has no caption', () => {
    const control = rowControl(renderRow({ label: 'Balanced', selected: false }));

    expect(control.props.accessibilityLabel).toBe('Balanced');
  });

  it('joins the label and its caption into one name', () => {
    const control = rowControl(
      renderRow({
        label: 'Lenient',
        description: 'Only serious problems',
        selected: false,
      })
    );

    expect(control.props.accessibilityLabel).toBe('Lenient and Only serious problems');
  });

  it('keeps the name while the row reports a save in flight', () => {
    const control = rowControl(
      renderRow({
        label: 'Lenient',
        description: 'Only serious problems',
        selected: false,
        busy: true,
        disabled: true,
      })
    );

    expect(control.props.accessibilityLabel).toBe('Lenient and Only serious problems');
    expect(control.props.accessibilityState).toEqual({
      checked: false,
      disabled: true,
      busy: true,
    });
  });

  it('leaves a custom-content row on the name its own text builds', () => {
    const control = rowControl(
      renderRow({ selected: true, children: createElement('Text', null, 'English') })
    );

    expect(control.props.accessibilityLabel).toBeUndefined();
  });

  it('uses a supplied name for custom content and keeps the checked state', () => {
    // The row's children spell out only part of what it means, so the caller
    // supplies the whole name; the state must still reach the screen reader.
    const control = rowControl(
      renderRow({
        selected: true,
        multi: true,
        accessibleName: 'acme/api, private repository',
        children: createElement('Text', null, 'acme/api'),
      })
    );

    expect(control.props.accessibilityLabel).toBe('acme/api, private repository');
    expect(control.props.accessibilityRole).toBe('checkbox');
    expect(control.props.accessibilityState).toEqual({ checked: true, disabled: false });
  });

  it('reports a multi-select row as a checkbox and a single choice as a radio', () => {
    const single = rowControl(renderRow({ label: 'One', selected: true }));
    expect(single.props.accessibilityRole).toBe('radio');

    const multiple = rowControl(renderRow({ label: 'Many', selected: true, multi: true }));
    expect(multiple.props.accessibilityRole).toBe('checkbox');
  });
});

describe('ChoiceRow touch target', () => {
  it('carries the shared row floor on the row node itself', () => {
    // A row sized by its own content reports that content's height as its
    // rect; the target the audit reads is the row node's own rect, so the floor
    // must be its class, not a hitSlop.
    for (const props of [
      { label: 'Balanced', selected: false },
      { label: 'Lenient', description: 'Only serious problems', selected: true },
      { selected: true, children: createElement('Text', null, 'English') },
    ]) {
      const control = rowControl(renderRow(props));

      expect(String(control.props.className).split(' ')).toContain(ROW_TARGET_CLASS);
      expect(control.props.hitSlop).toBeUndefined();
    }
  });
});

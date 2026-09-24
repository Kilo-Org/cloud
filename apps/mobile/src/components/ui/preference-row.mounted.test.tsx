/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type LucideIcon } from '@/components/ui/icons';
import { act, TestRenderer } from '@/test/renderer';

import { PreferenceRow } from './preference-row';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Switch: 'Switch',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#666666',
    secondaryForeground: '#111111',
  }),
}));

/** The row's icon prop takes a Lucide component; the test never inspects it. */
const Icon = (() => null) as unknown as LucideIcon;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(props: {
  value: boolean;
  disabled?: boolean;
  onValueChange: (next: boolean) => void;
}) {
  act(() => {
    const element = createElement(PreferenceRow, {
      icon: Icon,
      title: 'Let Kilo change app settings',
      subtitle: 'Applies to theme, language, notifications, models and the rest of Preferences.',
      disabled: false,
      ...props,
    });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing PreferenceRow renderer');
  }
  return renderer.root;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('PreferenceRow', () => {
  it('moves the switch when the title is pressed, so a tap on the label is a tap on the control', () => {
    const seen: boolean[] = [];
    const root = renderRow({
      value: true,
      onValueChange: next => {
        seen.push(next);
      },
    });
    const label = root.find(
      node =>
        Object.is(node.type, 'Pressable') &&
        node.props.accessibilityLabel === 'Let Kilo change app settings'
    );

    act(() => {
      (label.props.onPress as () => void)();
    });

    expect(seen).toEqual([false]);
  });

  it('leaves the native switch as its own control, so a tap on it does not fire twice', () => {
    const seen: boolean[] = [];
    const root = renderRow({
      value: true,
      onValueChange: next => {
        seen.push(next);
      },
    });
    const toggle = root.find(node => Object.is(node.type, 'Switch'));

    act(() => {
      (toggle.props.onValueChange as (next: boolean) => void)(false);
    });

    expect(seen).toEqual([false]);
    expect(toggle.props.accessibilityLabel).toBeUndefined();
    expect(toggle.props.accessible).toBe(false);
  });

  it('names only the pressable, so a tap on the title is one control not two', () => {
    const root = renderRow({
      value: true,
      onValueChange: () => undefined,
    });
    const named = root.findAll(
      node => node.props.accessibilityLabel === 'Let Kilo change app settings'
    );

    expect(named).toHaveLength(1);
    expect(named[0]?.props.accessibilityRole).toBe('switch');
    expect(named[0]?.props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
      checked: true,
    });
  });
});

import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { SettingsSwitchRow } from './settings-form-sections';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/utils', () => ({ cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(props: {
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  description?: string;
}) {
  act(() => {
    const element = createElement(SettingsSwitchRow, { label: 'openrouter', ...props });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing row renderer');
  }
  return renderer.root;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('SettingsSwitchRow', () => {
  it('exposes one switch per row: the native control, not the row around it', () => {
    const root = renderRow({
      value: true,
      onValueChange: vi.fn<(next: boolean) => void>(),
      description: 'Serves models',
    });

    const [control] = root.findAllByType('Switch');
    if (!control) {
      throw new Error('switch not found');
    }
    expect(control.props.accessibilityLabel).toBe('openrouter');
    expect(control.props.accessibilityHint).toBe('Serves models');
    expect(control.props.accessibilityState).toEqual({ checked: true, disabled: false });
    // The copy's tap target is a pointer convenience only: hidden from
    // accessibility, so a screen reader sees the switch once and never twice.
    expect(root.findAllByProps({ accessibilityRole: 'switch' })).toHaveLength(0);
    const [row] = root.findAllByType('Pressable');
    if (!row) {
      throw new Error('row target not found');
    }
    expect(row.props.accessible).toBe(false);
    expect(row.props.accessibilityElementsHidden).toBe(true);
    expect(row.props.importantForAccessibility).toBe('no-hide-descendants');
    // The copy's own node carries the 48dp frame, so the tap target clears the
    // 44dp floor even when the copy is a single short line.
    expect(row.props.className).toContain('min-h-[48px]');
  });

  it('toggles once whether the copy or the switch is tapped', () => {
    const onValueChange = vi.fn<(next: boolean) => void>();
    const root = renderRow({ value: true, onValueChange });

    const [row] = root.findAllByType('Pressable');
    if (!row) {
      throw new Error('row target not found');
    }
    act(() => {
      (row.props.onPress as () => void)();
    });
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenLastCalledWith(false);

    const [control] = root.findAllByType('Switch');
    if (!control) {
      throw new Error('switch not found');
    }
    act(() => {
      (control.props.onValueChange as (next: boolean) => void)(false);
    });
    expect(onValueChange).toHaveBeenCalledTimes(2);
    expect(onValueChange).toHaveBeenLastCalledWith(false);
  });

  it('marks both targets disabled when the row cannot be changed', () => {
    const onValueChange = vi.fn<(next: boolean) => void>();
    const root = renderRow({ value: false, onValueChange, disabled: true });

    const [row] = root.findAllByType('Pressable');
    if (!row) {
      throw new Error('row target not found');
    }
    expect(row.props.disabled).toBe(true);

    const [control] = root.findAllByType('Switch');
    if (!control) {
      throw new Error('switch not found');
    }
    expect(control.props.disabled).toBe(true);
    expect(control.props.accessibilityState).toEqual({ checked: false, disabled: true });
    expect(onValueChange).not.toHaveBeenCalled();
  });
});

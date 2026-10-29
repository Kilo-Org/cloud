import { type ElementType } from 'react';
import { type PressableProps, type SwitchProps, type ViewProps } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';

import { ToggleRow } from './settings-toggle-row';

const haptics = vi.hoisted(() => ({ selectionAsync: vi.fn<() => Promise<void>>() }));

vi.mock('expo-haptics', () => ({ selectionAsync: haptics.selectionAsync }));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'android' },
  I18nManager: { isRTL: false },
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/lib/utils', () => ({
  cn: (...classes: (string | undefined)[]) => classes.filter(Boolean).join(' '),
}));

type RowProps = Parameters<typeof ToggleRow>[0];

function renderRow(overrides: Partial<RowProps> = {}): ReactTestRenderer {
  const ref: { current: ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      <ToggleRow
        title="Enable auto-analysis"
        subtitle="Analyze findings as they are synced."
        value={false}
        disabled={false}
        onValueChange={() => undefined}
        {...overrides}
      />
    );
  });
  if (!ref.current) {
    throw new Error('ToggleRow did not mount');
  }
  return ref.current;
}

function only(renderer: ReactTestRenderer, type: string) {
  const node = renderer.root.findAllByType(type as ElementType)[0];
  if (!node) {
    throw new Error(`${type} did not render`);
  }
  return node;
}

// The test renderer types props as `unknown`; the component's own prop types
// are the contract these assertions read.
function rowProps(renderer: ReactTestRenderer): PressableProps {
  return only(renderer, 'Pressable').props as PressableProps;
}

function switchProps(renderer: ReactTestRenderer): SwitchProps {
  return only(renderer, 'Switch').props as SwitchProps;
}

// The row's press handler ignores its event argument, so the test invokes the
// handler through its bare (no-argument) form.
function pressRow(renderer: ReactTestRenderer): void {
  const handler = only(renderer, 'Pressable').props.onPress as (() => void) | undefined;
  handler?.();
}

describe('<ToggleRow>', () => {
  it.each([false, true])('flips a %s value once per press on the row', value => {
    haptics.selectionAsync.mockClear();
    const onValueChange = vi.fn<(next: boolean) => void>();
    const renderer = renderRow({ value, onValueChange });

    act(() => {
      pressRow(renderer);
    });

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(!value);
    expect(haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it('exposes the row as one switch carrying the name and state', () => {
    const props = rowProps(renderRow({ value: true, disabled: false }));

    expect(props.accessibilityRole).toBe('switch');
    expect(props.accessibilityLabel).toBe('Enable auto-analysis');
    expect(props.accessibilityState).toEqual({ checked: true, disabled: false });
  });

  it('lets a caller name the row apart from its title', () => {
    const props = rowProps(renderRow({ accessibilityLabel: 'Include existing findings' }));

    expect(props.accessibilityLabel).toBe('Include existing findings');
  });

  it('keeps a disabled row from toggling and reports it as disabled', () => {
    const onValueChange = vi.fn<(next: boolean) => void>();
    const props = rowProps(renderRow({ disabled: true, onValueChange }));

    expect(props.disabled).toBe(true);
    expect(props.accessibilityState?.disabled).toBe(true);
  });

  it('leaves the visual switch inert and out of the accessibility tree', () => {
    const renderer = renderRow({ value: true, disabled: true });
    const props = switchProps(renderer);
    const wrapper = only(renderer, 'Switch').parent;
    if (!wrapper) {
      throw new Error('the visual switch has no wrapper');
    }
    const wrapperProps = wrapper.props as ViewProps;

    expect(props.accessible).toBe(false);
    expect(props.value).toBe(true);
    expect(props.disabled).toBe(true);
    expect(props.onValueChange).toBeUndefined();
    expect(wrapperProps.pointerEvents).toBe('none');
    expect(wrapperProps.accessibilityElementsHidden).toBe(true);
    expect(wrapperProps.importantForAccessibility).toBe('no-hide-descendants');
  });
});

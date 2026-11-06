import { type ElementType } from 'react';
import { type PressableProps, type SwitchProps } from 'react-native';
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
function textProps(renderer: ReactTestRenderer): PressableProps {
  return only(renderer, 'Pressable').props as PressableProps;
}

function switchProps(renderer: ReactTestRenderer): SwitchProps {
  return only(renderer, 'Switch').props as SwitchProps;
}

// The text's press handler ignores its event argument, so the test invokes the
// handler through its bare (no-argument) form.
function pressText(renderer: ReactTestRenderer): void {
  const handler = only(renderer, 'Pressable').props.onPress as (() => void) | undefined;
  handler?.();
}

function changeSwitch(renderer: ReactTestRenderer, next: boolean): void {
  const handler = switchProps(renderer).onValueChange as ((value: boolean) => void) | undefined;
  handler?.(next);
}

describe('<ToggleRow>', () => {
  it.each([false, true])('flips a %s value once per press on the text', value => {
    haptics.selectionAsync.mockClear();
    const onValueChange = vi.fn<(next: boolean) => void>();
    const renderer = renderRow({ value, onValueChange });

    act(() => {
      pressText(renderer);
    });

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(!value);
    expect(haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it('flips the value the native switch reports, once per change', () => {
    haptics.selectionAsync.mockClear();
    const onValueChange = vi.fn<(next: boolean) => void>();
    const renderer = renderRow({ value: true, onValueChange });

    act(() => {
      changeSwitch(renderer, false);
    });

    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(onValueChange).toHaveBeenCalledWith(false);
    expect(haptics.selectionAsync).toHaveBeenCalledTimes(1);
  });

  it('exposes the switch as the row control with the name and state', () => {
    const props = switchProps(renderRow({ value: true, disabled: false }));

    expect(props.accessibilityLabel).toBe('Enable auto-analysis');
    expect(props.accessibilityState).toEqual({ checked: true, disabled: false });
    expect(props.value).toBe(true);
    expect(props.disabled).toBe(false);
  });

  it('lets a caller name the switch apart from its title', () => {
    const props = switchProps(renderRow({ accessibilityLabel: 'Include existing findings' }));

    expect(props.accessibilityLabel).toBe('Include existing findings');
  });

  it('gives the subtitle to assistive technology as the hint', () => {
    const props = switchProps(renderRow());

    // The text is out of the tree, so the name carries the title and the hint
    // carries the subtitle.
    expect(props.accessibilityLabel).toBe('Enable auto-analysis');
    expect(props.accessibilityHint).toBe('Analyze findings as they are synced.');
  });

  it('leaves the text out of the accessibility tree and keeps its tap', () => {
    const props = textProps(renderRow());

    expect(props.accessible).toBe(false);
    expect(props.accessibilityElementsHidden).toBe(true);
    expect(props.importantForAccessibility).toBe('no-hide-descendants');
    expect(props.accessibilityRole).toBeUndefined();
    expect(props.accessibilityLabel).toBeUndefined();
    expect(typeof props.onPress).toBe('function');
  });

  it('keeps a disabled row from toggling on either control', () => {
    haptics.selectionAsync.mockClear();
    const onValueChange = vi.fn<(next: boolean) => void>();
    const renderer = renderRow({ disabled: true, onValueChange });

    act(() => {
      pressText(renderer);
      changeSwitch(renderer, true);
    });

    expect(textProps(renderer).disabled).toBe(true);
    expect(switchProps(renderer).disabled).toBe(true);
    expect(switchProps(renderer).accessibilityState?.disabled).toBe(true);
    expect(onValueChange).not.toHaveBeenCalled();
    expect(haptics.selectionAsync).not.toHaveBeenCalled();
  });

  it('mutes the title while the row is unavailable and only then', () => {
    const disabled = renderRow({ disabled: true, value: true });
    const [disabledTitle] = disabled.root.findAllByType('Text' as ElementType);
    expect(String(disabledTitle?.props.className)).toContain('text-muted-foreground');

    const enabled = renderRow({ disabled: false, value: true });
    const [enabledTitle] = enabled.root.findAllByType('Text' as ElementType);
    expect(String(enabledTitle?.props.className)).not.toContain('text-muted-foreground');
  });

  it('flips the value when the selection tick rejects', async () => {
    const onValueChange = vi.fn<(next: boolean) => void>();
    haptics.selectionAsync.mockRejectedValue(new Error('no haptic engine'));
    const renderer = renderRow({ value: false, onValueChange });
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    try {
      process.on('unhandledRejection', onUnhandledRejection);
      act(() => {
        pressText(renderer);
      });
      // One macrotask, the turn Node flags an unhandled rejection in.
      const flushed = Promise.withResolvers<undefined>();
      setImmediate(() => {
        flushed.resolve(undefined);
      });
      await flushed.promise;

      expect(onValueChange).toHaveBeenCalledTimes(1);
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      haptics.selectionAsync.mockReset();
    }
  });
});

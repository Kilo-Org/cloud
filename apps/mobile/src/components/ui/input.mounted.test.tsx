import { createElement } from 'react';
import { type TextInputProps } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Input, INPUT_BOX_SHAPE_CLASS } from './input';
import { act, TestRenderer } from '@/test/renderer';
import { lightColors } from '@/lib/hooks/theme-colors.generated';
import { codeFieldTextStyle } from '@/lib/rtl-text';

const rtl = vi.hoisted(() => ({ isRTL: false }));
// Mutable so a suite can prove the placeholder follows the active palette. The
// inset is palette-independent; every suite resets the mock to the light tokens.
const appearance = vi.hoisted((): { colors: Record<string, string> } => ({ colors: {} }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  TextInput: 'TextInput',
  View: 'View',
  I18nManager: {
    get isRTL() {
      return rtl.isRTL;
    },
  },
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => appearance.colors,
}));

appearance.colors = lightColors;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  rtl.isRTL = false;
  appearance.colors = lightColors;
  act(() => {
    renderer?.unmount();
  });
});

/** The box's own props plus the resting preview's value. */
type InputTestProps = TextInputProps & { restingText?: string };

function mount(props: Readonly<InputTestProps> = {}) {
  act(() => {
    renderer = TestRenderer.create(createElement(Input, props));
  });
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function mountInput(props: Readonly<InputTestProps> = {}) {
  return mount(props).root.findByType('TextInput');
}

/** The native field's handlers, typed so a test can drive focus and typing. */
function fieldHandlers(node: TestRenderer.ReactTestInstance) {
  return node.props as {
    onFocus?: (event: unknown) => void;
    onChangeText?: (value: string) => void;
    onBlur?: (event: unknown) => void;
  };
}

/**
 * Flattens the component's nested style array the way React Native does, so a
 * test can assert the alignment that actually reaches the platform without
 * `StyleSheet` (the `react-native` mock above does not provide it).
 */
function flattenStyle(style: unknown): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const entry of Array.isArray(style) ? style : [style]) {
    if (Array.isArray(entry)) {
      Object.assign(merged, flattenStyle(entry));
    } else if (typeof entry === 'object' && entry !== null) {
      Object.assign(merged, entry);
    }
  }
  return merged;
}

describe('Input single-line box', () => {
  it('applies the RTL content alignment inline', () => {
    rtl.isRTL = true;

    expect(flattenStyle(mountInput().props.style).textAlign).toBe('right');
  });

  it('keeps a caller textAlign prop over the RTL default', () => {
    // React Native flattens `style` after the `textAlign` prop, so without
    // folding the prop into the style the injected right alignment would win.
    // The SLA day fields pass `textAlign="center"` and must stay centred.
    rtl.isRTL = true;

    expect(flattenStyle(mountInput({ textAlign: 'center' }).props.style).textAlign).toBe('center');
  });

  it('keeps a caller textAlign prop in a left-to-right interface', () => {
    rtl.isRTL = false;

    expect(flattenStyle(mountInput({ textAlign: 'center' }).props.style).textAlign).toBe('center');
  });

  it('keeps a code field’s own style and family on the native input', () => {
    // A setup command is code: the value stays left to right on its own left
    // edge with the family's ligatures off, so `--frozen-lockfile` draws as two
    // hyphens. The style reaches the native `TextInput` through this box, not
    // through a caller's own copy of it.
    const input = mountInput({ className: 'font-mono', style: codeFieldTextStyle() });

    expect(flattenStyle(input.props.style)).toMatchObject({
      direction: 'ltr',
      writingDirection: 'ltr',
      textAlign: 'left',
      fontVariant: ['no-common-ligatures', 'no-discretionary-ligatures', 'no-contextual'],
    });
    expect(String(input.props.className).split(' ')).toContain('font-mono');
  });

  it('keeps a code field on its left edge in a right-to-left interface', () => {
    // The shared RTL alignment is a patch in front of the caller's style, so a
    // command keeps the edge it was given instead of following a right-aligned
    // label.
    rtl.isRTL = true;

    const textAlign = flattenStyle(
      mountInput({ style: codeFieldTextStyle() }).props.style
    ).textAlign;

    expect(textAlign).toBe('left');
  });

  it('carries the exported single-line shape, so a preview box can swap with it', () => {
    const input = mountInput();
    const classes = String(input.props.className).split(' ');

    expect(classes).toEqual(expect.arrayContaining(INPUT_BOX_SHAPE_CLASS.split(' ')));
    // The export is the contract a read-only box reuses: the 44pt floor and the
    // physical horizontal inset, so the swap cannot change the row's height.
    expect(INPUT_BOX_SHAPE_CLASS.split(' ')).toEqual(['min-h-[44px]', 'pl-3', 'pr-3']);
    expect(classes).toContain('leading-[normal]');
  });

  it('leaves the single-line shape off a multiline field', () => {
    // A multiline field or a composer keeps its own text metrics and insets; its
    // surface is `InputFrame` instead, so it must not inherit the one-line box.
    const classes = String(mountInput({ multiline: true }).props.className).split(' ');

    expect(classes).not.toContain('min-h-[44px]');
    expect(classes).not.toContain('leading-[normal]');
    expect(classes).toEqual(expect.arrayContaining(['pt-2.5', 'pb-2.5', 'pl-3', 'pr-3']));
  });
});

describe('Input resting preview', () => {
  // Longer than the box, so a value that scrolled to its caret would show its
  // tail instead of the start this preview paints.
  const longValue = 'kilo-org/cloud-streaming-agent-session-worker-2026';

  it('paints the resting value from its start and keeps the real input', () => {
    const mounted = mount({ restingText: longValue });

    const previews = mounted.root.findAllByType('Text');

    expect(previews).toHaveLength(1);
    expect(previews[0].props.children).toBe(longValue);
    expect(mounted.root.findAllByType('TextInput')).toHaveLength(1);
  });

  it('paints the resting value with the input’s own weight and size', () => {
    // `Text` seats `text-base font-medium`; the native value is a normal-weight
    // `text-sm`, so the preview overrides both or the resting value changes
    // weight the moment it swaps back to the real input.
    const classes = String(
      mount({ restingText: longValue }).root.findByType('Text').props.className
    ).split(' ');

    expect(classes).toEqual(expect.arrayContaining(['text-sm', 'font-normal']));
  });

  it('drops the preview on focus and returns with the typed value on blur', () => {
    const mounted = mount({ restingText: longValue });

    act(() => {
      fieldHandlers(mounted.root.findByType('TextInput')).onFocus?.({});
    });

    expect(mounted.root.findAllByType('Text')).toHaveLength(0);
    // The wrapper stays across the state change: a field that swapped it out
    // would remount the native input and drop its text.
    expect(mounted.root.findAllByType('View')).toHaveLength(1);

    act(() => {
      const handlers = fieldHandlers(mounted.root.findByType('TextInput'));
      handlers.onChangeText?.('kilo');
      handlers.onBlur?.({});
    });

    expect(mounted.root.findByType('Text').props.children).toBe('kilo');
  });

  it('never paints a masked field’s value', () => {
    const mounted = mount({ restingText: longValue, secureTextEntry: true });

    expect(mounted.root.findAllByType('Text')).toHaveLength(0);
  });

  it('leaves a multiline field’s own box alone', () => {
    const mounted = mount({ restingText: longValue, multiline: true });

    expect(mounted.root.findAllByType('View')).toHaveLength(0);
    expect(mounted.root.findAllByType('Text')).toHaveLength(0);
  });

  it('keeps the placeholder of a field that rests without a value', () => {
    const mounted = mount({ restingText: '' });

    expect(mounted.root.findAllByType('Text')).toHaveLength(0);
    expect(mounted.root.findAllByType('TextInput')).toHaveLength(1);
  });

  it('adds no wrapper or preview to a field without a resting value', () => {
    const mounted = mount({ defaultValue: longValue });

    expect(mounted.root.findAllByType('View')).toHaveLength(0);
    expect(mounted.root.findAllByType('Text')).toHaveLength(0);
    expect(mounted.root.findAllByType('TextInput')).toHaveLength(1);
  });
});

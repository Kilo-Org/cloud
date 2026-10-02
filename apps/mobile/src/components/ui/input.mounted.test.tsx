import { createElement } from 'react';
import { type TextInputProps } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Input, INPUT_BOX_CLASS, INPUT_MULTILINE_INSET_CLASS } from './input';
import { act, TestRenderer } from '@/test/renderer';
import { compiledLengthDp } from '@/test/native-dimensions';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

const rtl = vi.hoisted(() => ({ isRTL: false }));
// Mutable so a suite can prove the placeholder follows the active palette. The
// inset is palette-independent; every suite resets the mock to the light tokens.
const appearance = vi.hoisted((): { colors: Record<string, string> } => ({ colors: {} }));
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  TextInput: 'TextInput',
  I18nManager: {
    get isRTL() {
      return rtl.isRTL;
    },
  },
}));
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

function mountInput(props: Readonly<TextInputProps> = {}) {
  act(() => {
    renderer = TestRenderer.create(createElement(Input, props));
  });
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer.root.findByType('TextInput');
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
  it('keeps the shared box free of vertical padding and a fixed height', () => {
    expect(INPUT_BOX_CLASS).toBe('min-h-[44px] px-3 leading-[normal]');
  });

  it('renders the shared box, centered vertical alignment, and the themed placeholder', () => {
    const input = mountInput();

    expect(input.props.className).toContain('min-h-[44px]');
    expect(input.props.className).toContain('px-3');
    expect(input.props.className).toContain('leading-[normal]');
    expect(input.props.className).not.toContain('py-');
    // min-h, never a fixed height, so Dynamic Type can still grow the field.
    expect(input.props.className).not.toMatch(/(?:^|\s)h-/);
    expect(input.props.textAlignVertical).toBe('center');
    expect(input.props.placeholderTextColor).toBe(lightColors.mutedForeground);
    expect(input.props.style).toBeUndefined();
  });

  it('forces the center alignment over a caller vertical alignment', () => {
    const input = mountInput({ textAlignVertical: 'top' });

    expect(input.props.textAlignVertical).toBe('center');
  });

  it('keeps a caller placeholder colour over the themed default', () => {
    const input = mountInput({ placeholderTextColor: '#123456' });

    expect(input.props.placeholderTextColor).toBe('#123456');
  });

  it('keeps a caller size and text size in the merged className', () => {
    const input = mountInput({ className: 'h-12 px-4 text-lg' });

    expect(input.props.className).toContain('h-12');
    expect(input.props.className).toContain('text-lg');
    expect(input.props.className).toContain('px-4');
    // The caller's horizontal padding wins; the box's floor and line height stay.
    expect(input.props.className).not.toContain('px-3');
    expect(input.props.className).toContain('min-h-[44px]');
    expect(input.props.className).toContain('leading-[normal]');
  });

  it('applies the RTL content alignment inline', () => {
    rtl.isRTL = true;

    expect(mountInput().props.style).toEqual([{ textAlign: 'right' }, undefined]);
  });

  it('keeps a caller textAlign prop over the RTL default', () => {
    // React Native flattens `style` after the `textAlign` prop, so without
    // folding the prop into the style the injected right alignment would win.
    // The SLA day fields pass `textAlign="center"` and must stay centred.
    rtl.isRTL = true;

    expect(flattenStyle(mountInput({ textAlign: 'center' }).props.style).textAlign).toBe('center');
  });

  it('keeps a caller textAlign prop after the caller style and the RTL default', () => {
    rtl.isRTL = true;

    const style = flattenStyle(
      mountInput({ textAlign: 'center', style: { color: '#abcdef' } }).props.style
    );

    expect(style).toEqual({ textAlign: 'center', color: '#abcdef' });
  });

  it('keeps a caller textAlign prop in a left-to-right interface', () => {
    rtl.isRTL = false;

    expect(flattenStyle(mountInput({ textAlign: 'center' }).props.style).textAlign).toBe('center');
  });
});

describe('Input multiline', () => {
  it('keeps the shared inset free of a height floor and a fixed line height', () => {
    // The inset is the single source of the multiline padding; a caller's own
    // `px-*`/`py-*` overrides it through tailwind-merge. It must never carry
    // `min-h-*`/`leading-*`, so the field's height and line box stay the
    // caller's (the profile description keeps `min-h-20 leading-5`).
    expect(INPUT_MULTILINE_INSET_CLASS).toBe('px-3 py-2.5');
  });

  it('applies the shared inset while keeping the caller line height and vertical alignment', () => {
    const input = mountInput({ multiline: true, className: 'leading-6', textAlignVertical: 'top' });

    expect(input.props.className).toBe(`${INPUT_MULTILINE_INSET_CLASS} leading-6`);
    // No single-line box leaks into a multiline field: no min-height floor and
    // no re-asserted line height from `INPUT_BOX_CLASS`.
    expect(input.props.className).not.toContain('min-h-[44px]');
    expect(input.props.className).not.toContain('leading-[normal]');
    expect(input.props.textAlignVertical).toBe('top');
  });

  it('lets a caller own horizontal and vertical padding override the shared inset', () => {
    const input = mountInput({ multiline: true, className: 'px-4 py-3 leading-5' });

    expect(input.props.className).toContain('px-4');
    expect(input.props.className).toContain('py-3');
    expect(input.props.className).not.toContain('px-3');
    expect(input.props.className).not.toContain('py-2.5');
  });

  it('compiles the shared inset to the real native padding that clears the value and placeholder', async () => {
    // A token assertion pins intent; compiling the same class through the app's
    // NativeWind compiler pins the box the platform lays out — the rules Metro
    // emits and the on-device accessibility explorer measures. At the app's
    // 14pt rem `px-3` is 10.5pt and `py-2.5` is 8.75pt per side. Padding is
    // static, so focus and an open keyboard do not change it.
    expect(await compiledLengthDp(INPUT_MULTILINE_INSET_CLASS, 'paddingInline')).toBe(10.5);
    expect(await compiledLengthDp(INPUT_MULTILINE_INSET_CLASS, 'paddingBlock')).toBe(8.75);
  });

  // The profile description field (`components/profiles/profile-overview-screen.tsx`)
  // renders exactly this call: `multiline`, top-aligned, `min-h-20 leading-5`.
  // The token assertions above pin intent; this compiles the merged className
  // through the app's NativeWind compiler — the rules Metro emits and RN's
  // Fabric text input turns into its text-container inset — so the native box
  // the value and placeholder are drawn in is asserted, not just the tokens.
  // The values are palette-independent; the placeholder colour is the active
  // palette's `mutedForeground`. Padding is static, so focus and an open
  // keyboard do not change it.
  it.each([
    ['light', lightColors],
    ['dark', darkColors],
  ] as const)(
    'lays out the profile description inset and palette in %s mode',
    async (_mode, colors) => {
      appearance.colors = colors;
      const input = mountInput({
        multiline: true,
        textAlignVertical: 'top',
        className: 'min-h-20 leading-5',
      });
      const className = input.props.className as string;

      // `px-3` is 10.5pt and `py-2.5` is 8.75pt at the app's 14pt rem, so the
      // value and the placeholder clear the border instead of hugging it.
      expect(await compiledLengthDp(className, 'paddingInline')).toBe(10.5);
      expect(await compiledLengthDp(className, 'paddingBlock')).toBe(8.75);
      // The caller's `min-h-20` floor survives the inset merge.
      expect(await compiledLengthDp(className, 'minHeight')).toBe(70);
      expect(input.props.textAlignVertical).toBe('top');
      expect(input.props.placeholderTextColor).toBe(colors.mutedForeground);
    }
  );

  it('compiles a caller padding override instead of the shared inset', async () => {
    const input = mountInput({ multiline: true, className: 'px-4 py-3 leading-5' });
    const className = input.props.className as string;

    // tailwind-merge drops the shared `px-3`/`py-2.5` before NativeWind sees
    // them, so the native box is the caller's 14pt/10.5pt padding.
    expect(await compiledLengthDp(className, 'paddingInline')).toBe(14);
    expect(await compiledLengthDp(className, 'paddingBlock')).toBe(10.5);
  });

  it('does not force an alignment when the caller sets none', () => {
    const input = mountInput({ multiline: true });

    expect(input.props.className).toBe(INPUT_MULTILINE_INSET_CLASS);
    expect(input.props.className).not.toContain('min-h-[44px]');
    expect(input.props.className).not.toContain('leading-[normal]');
    expect(input.props.textAlignVertical).toBeUndefined();
  });
});

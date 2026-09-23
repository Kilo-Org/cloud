import { createElement } from 'react';
import { type TextInputProps } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Input, INPUT_BOX_CLASS } from './input';
import { act, TestRenderer } from '@/test/renderer';

const rtl = vi.hoisted(() => ({ isRTL: false }));
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
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

afterEach(() => {
  rtl.isRTL = false;
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
    expect(input.props.placeholderTextColor).toBe('#888888');
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
});

describe('Input multiline', () => {
  it('keeps the caller box and vertical alignment', () => {
    const input = mountInput({ multiline: true, className: 'leading-6', textAlignVertical: 'top' });

    expect(input.props.className).toBe('leading-6');
    expect(input.props.className).not.toContain('min-h-[44px]');
    expect(input.props.textAlignVertical).toBe('top');
  });

  it('does not force an alignment when the caller sets none', () => {
    const input = mountInput({ multiline: true });

    expect(input.props.className).not.toContain('min-h-[44px]');
    expect(input.props.textAlignVertical).toBeUndefined();
  });
});

import { createElement } from 'react';
import { type TextInputProps } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Input } from './input';
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
});

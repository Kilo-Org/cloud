import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { OrganizationPlanRefusal } from './plan-refusal';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/icons', () => ({ AlertCircle: 'AlertCircle' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ destructive: '#ff0000' }),
}));
vi.mock('@/lib/utils', () => ({ cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderBlock(props: { action?: { label: string; onPress: () => void } }) {
  act(() => {
    const element = createElement(OrganizationPlanRefusal, { message: 'Trial ended.', ...props });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing refusal renderer');
  }
  return renderer.root;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('OrganizationPlanRefusal', () => {
  it('states the explanation as an error and offers nothing without an action', () => {
    const root = renderBlock({});

    expect(root.findByType('AccessibleStatus').props).toMatchObject({
      message: 'Trial ended.',
      tone: 'error',
    });
    expect(root.findAllByType('Pressable')).toHaveLength(0);
  });

  it('renders the action on its own target and presses it', () => {
    const onPress = vi.fn<() => void>();
    const root = renderBlock({ action: { label: 'Manage billing', onPress } });

    const [control] = root.findAllByType('Pressable');
    if (!control) {
      throw new Error('action control not found');
    }
    expect(control.props.accessibilityRole).toBe('button');
    expect(control.props.accessibilityLabel).toBe('Manage billing');
    // The action reads as one line of copy under the message: its visible box
    // is the control-size audit's floor plus the label line, and `hitSlop`
    // carries the design target, so the tile's own padding stays symmetric.
    expect(control.props.className).toContain('min-h-[32px]');
    expect(control.props.className).not.toContain('min-h-[48px]');
    expect(control.props.hitSlop).toEqual({ top: 9, bottom: 9, left: 5, right: 5 });
    const label = root.findByType('Text');
    expect(label.props.children).toBe('Manage billing');
    // The brand primary is off-palette on the error-tinted surface (olive in
    // light, saturated yellow in dark), so the action wears the message's ink
    // and marks itself as the action by its underline instead of by hue.
    expect(label.props.className).toContain('text-destructive');
    expect(label.props.className).toContain('underline');
    expect(label.props.className).not.toContain('text-primary');

    act(() => {
      (control.props.onPress as () => void)();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

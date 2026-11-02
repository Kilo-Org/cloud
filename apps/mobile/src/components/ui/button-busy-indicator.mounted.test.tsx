import { createElement } from 'react';
import { View } from 'react-native';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Button, BUTTON_BUSY_OVERLAY_CLASS, type ButtonProps } from './button';

const theme = vi.hoisted(() => ({
  colors: {
    foreground: '#123456',
    primary: '#345678',
    primaryForeground: '#abcdef',
    accentSoftTintForeground: '#1a1a10',
  },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => theme.colors }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function render(props: ButtonProps) {
  act(() => {
    const element = createElement(Button, props, 'Send');
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing Button renderer');
  }
  return renderer.root;
}

function busySpinnerColor(root: TestRenderer.ReactTestInstance): string {
  return root.findByProps({ size: 'small' }).props.color;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

describe('Button busy indicator', () => {
  it('draws the accent-soft spinner in the ink its own label uses', () => {
    // The label paints with `text-accent-soft-tint-foreground`; the spinner
    // beside it must follow the same token, so a palette change moves both
    // states in either theme instead of leaving the spinner on its old value.
    expect(busySpinnerColor(render({ variant: 'accent-soft', loading: true }))).toBe('#1a1a10');

    theme.colors.accentSoftTintForeground = '#0b0b0b';
    try {
      expect(busySpinnerColor(render({ variant: 'accent-soft', loading: true }))).toBe('#0b0b0b');
    } finally {
      theme.colors.accentSoftTintForeground = '#1a1a10';
    }
  });

  it('keeps the busy state and name on the button, not on the indicator', () => {
    const root = render({ loading: true, accessibilityLabel: 'Send' });

    const overlay = root.find(
      node =>
        node.type === View &&
        node.props.className === BUTTON_BUSY_OVERLAY_CLASS &&
        node.findAll(child => child.props.size === 'small').length > 0
    );
    expect(overlay.props.accessibilityElementsHidden).toBe(true);
    expect(overlay.props.importantForAccessibility).toBe('no-hide-descendants');

    const button = root.findByType('Pressable' as never);
    expect(button.props.accessibilityLabel).toBe('Send');
    expect(button.props.accessibilityState).toEqual({ disabled: true, busy: true });
  });
});

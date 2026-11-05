import { createElement, type ElementType } from 'react';
import { View } from 'react-native';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Button, BUTTON_BUSY_OVERLAY_CLASS, type ButtonProps } from './button';

// Every token the ink table names, with a distinct value each: a mark drawn
// from the wrong token renders a different colour, so the case below fails
// instead of passing on two tokens that happen to share a value.
const theme = vi.hoisted(() => ({
  colors: {
    foreground: '#123456',
    primary: '#345678',
    primaryForeground: '#abcdef',
    secondaryForeground: '#223344',
    destructive: '#654321',
    destructiveSolidForeground: '#fedcba',
    accentSoftTintForeground: '#1a1a10',
  },
}));
const platform = vi.hoisted(() => ({ OS: 'android' }));

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: platform,
  Pressable: 'Pressable',
  Text: 'Text',
  View: 'View',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => theme.colors }));

const BusyMark = 'ActivityIndicator' as ElementType;
const busyMarks = (node: TestRenderer.ReactTestInstance) => node.findAllByType(BusyMark);

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

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  platform.OS = 'android';
});

describe('Button busy mark', () => {
  it('draws the accent-soft mark in the ink its own label uses', () => {
    // The label paints with `text-accent-soft-tint-foreground`; the mark beside
    // it must follow the same token, so a palette change moves both states in
    // either theme instead of leaving the mark on its old value.
    const markColor = (root: TestRenderer.ReactTestInstance) =>
      busyMarks(root)[0]?.props.color as string;

    expect(markColor(render({ variant: 'accent-soft', loading: true }))).toBe('#1a1a10');

    theme.colors.accentSoftTintForeground = '#0b0b0b';
    try {
      expect(markColor(render({ variant: 'accent-soft', loading: true }))).toBe('#0b0b0b');
    } finally {
      theme.colors.accentSoftTintForeground = '#1a1a10';
    }
  });

  // The label paints from the same table entry the mark does, so every variant
  // draws its busy mark in the ink its own label carries. Listing the pairs here
  // rather than deriving them keeps the contract independent of the table.
  it.each([
    ['default', theme.colors.primaryForeground],
    ['destructive', theme.colors.destructiveSolidForeground],
    ['outline', theme.colors.foreground],
    ['outline-destructive', theme.colors.destructive],
    ['secondary', theme.colors.secondaryForeground],
    ['ghost', theme.colors.foreground],
    ['link', theme.colors.primary],
    ['accent-soft', theme.colors.accentSoftTintForeground],
  ] as const)('draws the %s mark in the ink its own label paints', (variant, ink) => {
    const root = render({ variant, loading: true, accessibilityLabel: 'Send' });

    expect(busyMarks(root)[0]?.props.color).toBe(ink);
    const track = root.find(
      n => n.type === View && `${n.props.className ?? ''}`.includes('rounded-full')
    );
    expect(track.props.style).toMatchObject({ borderColor: ink });
  });
  it.each(['default', 'icon'] as const)(
    'leaves the native iOS spinner unobstructed for size %s',
    size => {
      platform.OS = 'ios';
      const root = render({ loading: true, size, accessibilityLabel: 'Send' });
      const paintedTracks = root.findAll(node => {
        const style = node.props.style as { borderColor?: string } | undefined;
        return node.type === View && style?.borderColor !== undefined;
      });

      expect(busyMarks(root)).toHaveLength(1);
      expect(paintedTracks).toHaveLength(0);
    }
  );

  it('keeps the busy state and name on the button, not on the mark', () => {
    const root = render({ loading: true, accessibilityLabel: 'Send' });

    const overlay = root.find(
      node =>
        node.type === View &&
        node.props.className === BUTTON_BUSY_OVERLAY_CLASS &&
        busyMarks(node).length > 0
    );
    expect(overlay.props.accessibilityElementsHidden).toBe(true);
    expect(overlay.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(busyMarks(overlay)[0]?.props.accessible).toBe(false);

    const button = root.findByType('Pressable' as never);
    expect(button.props.accessibilityLabel).toBe('Send');
    expect(button.props.accessibilityState).toEqual({ disabled: true, busy: true });
  });
});

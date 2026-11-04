import { createElement, type ElementType } from 'react';
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
  I18nManager: { isRTL: false },
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

  it('paints a full ring track in the label ink, so the mark never shrinks to the arc sweep', () => {
    // Android's indeterminate arc sweeps from near-zero, so a still capture of
    // the platform control can show a speck of ink. The track holds the mark at
    // the label's line height in every frame, and it paints the same ink the
    // label does: a diluted track reads as a faint gray ring on the pale
    // accent-soft fill instead of the olive the label carries.
    const root = render({ variant: 'accent-soft', loading: true });
    const overlay = root.find(n => n.props.className === BUTTON_BUSY_OVERLAY_CLASS);
    const track = overlay.find(
      n => n.type === View && `${n.props.className ?? ''}`.includes('rounded-full')
    );

    expect(track.props.style).toMatchObject({ width: 17, height: 17, borderColor: '#1a1a10' });
    expect(`${track.props.className ?? ''}`).toContain('border-2');
    expect(`${track.props.className ?? ''}`).not.toMatch(/\bopacity-/);
  });

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

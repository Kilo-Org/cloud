// Tap geometry of the voice toggle: a control-size audit measures the box a
// control renders on its own node, so the toolbar `lg` size carries the shared
// 48dp box on the pressable and keeps its visual circle inside it.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { VoiceInputButton } from './voice-input-control';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';

vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/icons', () => ({ Mic: 'Mic', Square: 'Square' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ destructiveForeground: '#fff', foreground: '#000' }),
}));
// The label is the control's copy, not its geometry, and the catalog is not
// what this suite measures.
vi.mock('@/lib/voice-input/voice-input-view-state', () => ({
  resolveVoiceInputControlState: () => ({
    accessibilityLabel: 'Start voice input',
    busy: false,
    disabled: false,
    icon: 'microphone',
    showListeningStatus: false,
  }),
}));

type Props = {
  hitSlop?: { bottom: number; left: number; right: number; top: number };
  size?: 'sm' | 'md' | 'lg';
};

async function renderButton(props: Props) {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(
      createElement(VoiceInputButton, {
        disabled: false,
        onPress: () => undefined,
        status: 'idle',
        ...props,
      })
    );
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function classNamesOfType(
  renderer: TestRenderer.ReactTestRenderer,
  type: string
): (string | undefined)[] {
  return renderer.root
    .findAll(node => Object.is(node.type, type))
    .map(node => node.props.className as string | undefined);
}

describe('VoiceInputButton tap geometry', () => {
  it('carries the shared 48dp box on the toolbar size own node', async () => {
    const renderer = await renderButton({ size: 'lg' });

    const [button] = renderer.root.findAll(node => Object.is(node.type, 'Pressable'));
    expect(String(button?.props.className)).toContain(ICON_TARGET_BOX_CLASS);
    // The box is the whole target, so no slop is added on top of it.
    expect(button?.props.hitSlop).toBeUndefined();
  });

  it('keeps the toolbar size visual circle inside its box', async () => {
    const renderer = await renderButton({ size: 'lg' });

    const [visual] = classNamesOfType(renderer, 'View');
    expect(String(visual)).toContain('h-10 w-10');
    expect(String(visual)).toContain('rounded-full');
    expect(String(visual)).toContain('bg-secondary');
  });

  it('keeps the smaller size frame and its own slop on the pressable', async () => {
    const renderer = await renderButton({ size: 'md' });

    const [button] = renderer.root.findAll(node => Object.is(node.type, 'Pressable'));
    expect(String(button?.props.className)).toContain('h-9 w-9');
    expect(String(button?.props.className)).not.toContain(ICON_TARGET_BOX_CLASS);
    expect(button?.props.hitSlop).toEqual({ top: 4, bottom: 4, left: 4, right: 4 });
    expect(classNamesOfType(renderer, 'View')).toHaveLength(0);
  });

  it('ignores a caller slop when the toolbar size box carries the whole target', async () => {
    const renderer = await renderButton({
      hitSlop: { top: 3, bottom: 3, left: 0, right: 0 },
      size: 'lg',
    });

    const [button] = renderer.root.findAll(node => Object.is(node.type, 'Pressable'));
    expect(button?.props.hitSlop).toBeUndefined();
  });
});

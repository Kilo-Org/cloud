// Tap geometry of the voice toggle: a control-size audit measures the box a
// control renders on its own node, so the toolbar `lg` size carries the shared
// 48dp box on the pressable and draws its icon there. The resting state paints
// no fill, because a circle smaller than the send control's filled circle beside
// it reads as a mismatched dot; the whole box fills while a session is live.

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
  status?: 'idle' | 'listening';
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

describe('VoiceInputButton tap geometry', () => {
  it('carries the shared 48dp box on the toolbar size own node', async () => {
    const renderer = await renderButton({ size: 'lg' });

    const [button] = renderer.root.findAll(node => Object.is(node.type, 'Pressable'));
    expect(String(button?.props.className)).toContain(ICON_TARGET_BOX_CLASS);
    // The box is the whole target, so no slop is added on top of it.
    expect(button?.props.hitSlop).toBeUndefined();
  });

  it('paints no resting fill on the toolbar size', async () => {
    const renderer = await renderButton({ size: 'lg' });

    const [button] = renderer.root.findAll(node => Object.is(node.type, 'Pressable'));
    expect(String(button?.props.className)).toContain('rounded-full');
    expect(String(button?.props.className)).not.toContain('bg-secondary');
    expect(String(button?.props.className)).not.toContain('bg-red-600');
    // The icon is the box's own child: a smaller framed circle inside the box
    // would be the mismatched dot this size no longer draws.
    expect(renderer.root.findAll(node => Object.is(node.type, 'View'))).toHaveLength(0);
    expect(renderer.root.findAll(node => Object.is(node.type, 'Mic'))).toHaveLength(1);
  });

  it('fills the whole box while a session is live', async () => {
    const renderer = await renderButton({ size: 'lg', status: 'listening' });

    const [button] = renderer.root.findAll(node => Object.is(node.type, 'Pressable'));
    expect(String(button?.props.className)).toContain(ICON_TARGET_BOX_CLASS);
    expect(String(button?.props.className)).toContain('bg-red-600');
  });

  it('keeps the smaller size frame and its own slop on the pressable', async () => {
    const renderer = await renderButton({ size: 'md' });

    const [button] = renderer.root.findAll(node => Object.is(node.type, 'Pressable'));
    expect(String(button?.props.className)).toContain('h-9 w-9');
    expect(String(button?.props.className)).toContain('bg-secondary');
    expect(String(button?.props.className)).not.toContain(ICON_TARGET_BOX_CLASS);
    expect(button?.props.hitSlop).toEqual({ top: 4, bottom: 4, left: 4, right: 4 });
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

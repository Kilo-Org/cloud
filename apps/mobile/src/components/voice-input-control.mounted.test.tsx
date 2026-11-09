import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { VoiceInputButton } from './voice-input-control';

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('@/components/ui/icons', () => ({ Mic: 'Mic', Square: 'Square' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ destructiveForeground: '#000000', foreground: '#000000' }),
}));
vi.mock('@/lib/voice-input/voice-input-view-state', () => ({
  resolveVoiceInputControlState: () => ({
    accessibilityLabel: 'voice',
    busy: false,
    disabled: false,
    icon: 'microphone',
    showListeningStatus: false,
  }),
}));

function render(props: {
  size?: 'sm' | 'md' | 'lg';
  hitSlop?: { top: number; bottom: number; left: number; right: number };
}): TestRenderer.ReactTestInstance {
  const holder: { current?: TestRenderer.ReactTestRenderer } = {};
  act(() => {
    holder.current = TestRenderer.create(
      createElement(VoiceInputButton, {
        disabled: false,
        onPress: () => undefined,
        status: 'idle' as const,
        ...props,
      })
    );
  });
  if (!holder.current) {
    throw new Error('renderer was not created');
  }
  return holder.current.root;
}

function hostNodes(
  root: TestRenderer.ReactTestInstance,
  type: string
): TestRenderer.ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string' && (node.type as string) === type);
}

describe('VoiceInputButton — lg touch target', () => {
  // The regression this guards: `lg` rendered a 35dp pressable frame, so the
  // node a control-size audit reads was under both platform minimums and the
  // 4dp slop (one side zeroed by the composer row) could not lift the rect.
  it('puts the 48dp target on the pressable and keeps the 35dp circle inside', () => {
    const root = render({ size: 'lg' });
    const [pressable] = hostNodes(root, 'Pressable');
    const [circle] = hostNodes(root, 'View');

    expect(pressable?.props.style).toMatchObject({ width: 48, height: 48 });
    expect(circle?.props.style).toMatchObject({ width: 35, height: 35 });
    expect(pressable?.props.hitSlop).toEqual({ top: 4, bottom: 4, left: 4, right: 4 });
  });

  it('lets the caller replace the slop, as the composer row zeroes its facing side', () => {
    const facing = { top: 4, bottom: 4, left: 0, right: 4 };
    const root = render({ size: 'lg', hitSlop: facing });
    const [pressable] = hostNodes(root, 'Pressable');

    expect(pressable?.props.hitSlop).toEqual(facing);
    expect(pressable?.props.style).toMatchObject({ width: 48, height: 48 });
  });

  it('leaves the smaller sizes and the default on their shipped frames', () => {
    const md = render({ size: 'md' });
    const [mdPressable] = hostNodes(md, 'Pressable');
    expect(mdPressable?.props.className).toContain('h-9 w-9');
    expect(mdPressable?.props.style).toBeUndefined();
    expect(hostNodes(md, 'View')).toHaveLength(0);

    const fallback = render({});
    const [defaultPressable] = hostNodes(fallback, 'Pressable');
    expect(defaultPressable?.props.className).toContain('h-10 w-10');
    expect(defaultPressable?.props.hitSlop).toEqual({ top: 2, bottom: 2, left: 2, right: 2 });
  });
});

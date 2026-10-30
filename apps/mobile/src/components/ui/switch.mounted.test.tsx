import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { Switch } from './switch';

const native = vi.hoisted(() => ({ os: 'ios' }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
  Switch: 'Switch',
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#8A8680',
    primary: '#FFDD00',
    card: '#17171A',
  }),
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

type SwitchUnderTest = {
  disabled?: boolean;
  accessibilityState?: { busy?: boolean };
  trackColor?: { false?: string; true?: string };
  thumbColor?: string;
};

function renderSwitch(props: SwitchUnderTest) {
  const ref: { current: R | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Switch, { value: false, ...props }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function nativeProps(root: I): {
  disabled?: boolean;
  accessibilityState?: { disabled?: boolean; busy?: boolean };
  trackColor?: { false?: string; true?: string };
  thumbColor?: string;
} {
  const node = root.findAll(candidate => (candidate.type as string) === 'Switch')[0];
  if (!node) {
    throw new Error('native Switch was not rendered');
  }
  return node.props as never;
}

describe('Switch', () => {
  it('mirrors disabled into the accessibility state on iOS', () => {
    native.os = 'ios';
    const props = nativeProps(renderSwitch({ disabled: true }).root);
    expect(props.disabled).toBe(true);
    expect(props.accessibilityState?.disabled).toBe(true);
  });

  it('keeps the other accessibility state members on iOS', () => {
    native.os = 'ios';
    const props = nativeProps(
      renderSwitch({ disabled: true, accessibilityState: { busy: true } }).root
    );
    expect(props.accessibilityState).toEqual({ busy: true, disabled: true });
  });

  it('leaves the accessibility state alone on Android', () => {
    native.os = 'android';
    const props = nativeProps(renderSwitch({ disabled: true }).root);
    expect(props.disabled).toBe(true);
    expect(props.accessibilityState).toBeUndefined();
  });

  it('reports an enabled switch as enabled on iOS', () => {
    native.os = 'ios';
    const props = nativeProps(renderSwitch({ disabled: false }).root);
    expect(props.accessibilityState?.disabled).toBe(false);
  });

  // The platform draws its own track from a system colour, which in the dark
  // scheme sits within 1.11:1 of the card, so an off switch lost its track.
  it('themes the track in both states so it stays readable', () => {
    native.os = 'android';
    const props = nativeProps(renderSwitch({}).root);
    expect(props.trackColor).toEqual({ false: '#8A8680', true: '#FFDD00' });
  });

  it('keeps the thumb on its own surface colour', () => {
    native.os = 'android';
    const props = nativeProps(renderSwitch({}).root);
    expect(props.thumbColor).toBe('#17171A');
  });

  it('keeps the colours a caller passes', () => {
    native.os = 'android';
    const props = nativeProps(
      renderSwitch({
        trackColor: { false: '#111111', true: '#222222' },
        thumbColor: '#333333',
      }).root
    );
    expect(props.trackColor).toEqual({ false: '#111111', true: '#222222' });
    expect(props.thumbColor).toBe('#333333');
  });
});

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { darkColors } from '@/lib/hooks/theme-colors.generated';

import { Switch } from './switch';

const native = vi.hoisted(() => ({ os: 'ios', scheme: 'light' }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
  useColorScheme: () => native.scheme,
  Switch: 'Switch',
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

function renderSwitch(props: {
  disabled?: boolean;
  accessibilityState?: { busy?: boolean };
  trackColor?: { false?: string; true?: string };
}) {
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
} {
  const node = root.findAll(candidate => (candidate.type as string) === 'Switch')[0];
  if (!node) {
    throw new Error('native Switch was not rendered');
  }
  return node.props as never;
}

describe('Switch', () => {
  beforeEach(() => {
    native.os = 'ios';
    native.scheme = 'light';
  });

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

  it('gives the off track a visible neutral in the Android dark theme', () => {
    native.os = 'android';
    native.scheme = 'dark';
    const props = nativeProps(renderSwitch({ disabled: false }).root);
    expect(props.trackColor).toEqual({ false: darkColors.mutedSoft });
  });

  it('keeps the on track and a caller track color beside the dark off track', () => {
    native.os = 'android';
    native.scheme = 'dark';
    const props = nativeProps(
      renderSwitch({ disabled: false, trackColor: { true: '#00FF00' } }).root
    );
    expect(props.trackColor).toEqual({
      true: '#00FF00',
      false: darkColors.mutedSoft,
    });
  });

  it('keeps the platform track colors in the light theme', () => {
    native.os = 'android';
    native.scheme = 'light';
    const props = nativeProps(renderSwitch({ disabled: false }).root);
    expect(props.trackColor).toBeUndefined();
  });

  it('keeps the platform track colors on iOS in the dark theme', () => {
    native.os = 'ios';
    native.scheme = 'dark';
    const props = nativeProps(renderSwitch({ disabled: false }).root);
    expect(props.trackColor).toBeUndefined();
  });
});

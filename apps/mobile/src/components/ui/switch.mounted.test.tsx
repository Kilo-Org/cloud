import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
import { darkColors, lightColors } from '@/lib/hooks/use-theme-colors';
import { Switch } from './switch';

const native = vi.hoisted(() => ({ os: 'ios', scheme: 'light' as 'light' | 'dark' }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
  useColorScheme: () => native.scheme,
  Switch: 'Switch',
  View: 'View',
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

type SwitchFixture = {
  disabled?: boolean;
  accessibilityState?: { busy?: boolean; disabled?: boolean };
  trackColor?: { false?: string; true?: string };
  thumbColor?: string;
  value?: boolean;
  style?: { marginVertical?: number };
  onValueChange?: (next: boolean) => void;
};

function renderSwitch(props: SwitchFixture) {
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
  value?: boolean;
  style?: unknown;
  onStartShouldSetResponder?: () => boolean;
} {
  const node = root.findAll(candidate => (candidate.type as string) === 'Switch')[0];
  if (!node) {
    throw new Error('native Switch was not rendered');
  }
  return node.props as never;
}

function touchBox(root: I):
  | {
      accessible?: boolean;
      style?: unknown;
      onStartShouldSetResponder?: () => boolean;
      onResponderRelease?: () => void;
    }
  | undefined {
  return root.findAll(candidate => (candidate.type as string) === 'View')[0]?.props;
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

  it('paints the palette on the track and the grip', () => {
    native.os = 'android';
    native.scheme = 'light';
    const props = nativeProps(renderSwitch({}).root);
    expect(props.trackColor).toEqual({ false: lightColors.mutedSoft, true: lightColors.primary });
    expect(props.thumbColor).toBe(lightColors.primaryForeground);
  });

  it('paints the light grip on the on track', () => {
    native.os = 'android';
    native.scheme = 'light';
    const props = nativeProps(renderSwitch({ value: true }).root);
    expect(props.trackColor).toEqual({ false: lightColors.mutedSoft, true: lightColors.primary });
    expect(props.thumbColor).toBe(lightColors.primaryForeground);
  });

  it('keeps the off state readable in dark mode', () => {
    native.os = 'android';
    native.scheme = 'dark';
    const props = nativeProps(renderSwitch({ value: false }).root);
    expect(props.trackColor).toEqual({
      false: darkColors.mutedForeground,
      true: darkColors.selection,
    });
    expect(props.thumbColor).toBe(darkColors.foreground);
    expect(props.thumbColor).not.toBe(darkColors.primaryForeground);
  });

  // Dark's accent is the brand yellow, which glares on the near-black page; the
  // on pair takes the muted olive both schemes share instead.
  it('paints the dark on track with the muted olive, not the accent', () => {
    native.os = 'android';
    native.scheme = 'dark';
    const props = nativeProps(renderSwitch({ value: true }).root);
    expect(props.trackColor).toEqual({
      false: darkColors.mutedForeground,
      true: darkColors.selection,
    });
    expect(props.trackColor?.true).not.toBe(darkColors.primary);
    expect(props.thumbColor).toBe(darkColors.selectionForeground);
  });

  it('keeps track and grip colors a caller supplies', () => {
    native.os = 'android';
    native.scheme = 'dark';
    const props = nativeProps(
      renderSwitch({ trackColor: { false: '#222222', true: '#111111' }, thumbColor: '#333333' })
        .root
    );
    expect(props.trackColor).toEqual({ false: '#222222', true: '#111111' });
    expect(props.thumbColor).toBe('#333333');
  });

  it('gives the Android control a full touch target on both axes, with no touch box', () => {
    native.os = 'android';
    const root = renderSwitch({}).root;
    const props = nativeProps(root);
    expect((props.style as unknown[])[0]).toEqual({
      minHeight: TOUCH_TARGET_DP,
      minWidth: TOUCH_TARGET_DP,
    });
    expect(props.onStartShouldSetResponder).toBeUndefined();
    expect(touchBox(root)).toBeUndefined();
  });

  it('applies a caller style after the touch target box on Android', () => {
    native.os = 'android';
    const style = { marginVertical: 3 };
    const props = nativeProps(renderSwitch({ style }).root);
    expect(props.style).toEqual([{ minHeight: TOUCH_TARGET_DP, minWidth: TOUCH_TARGET_DP }, style]);
  });

  it('centers the iOS control at its own size in a hidden 44pt touch box', () => {
    native.os = 'ios';
    const style = { marginVertical: 3 };
    const root = renderSwitch({ style }).root;
    const props = nativeProps(root);
    expect(props.style).toBeUndefined();
    expect(props.onStartShouldSetResponder?.()).toBe(true);
    const box = touchBox(root);
    expect(box?.accessible).toBe(false);
    expect(box?.style).toEqual([
      { alignSelf: 'center', justifyContent: 'center', minHeight: TOUCH_TARGET_DP },
      style,
    ]);
  });

  it('flips the iOS value when a tap in the touch box ends, and not when disabled', () => {
    native.os = 'ios';
    const onValueChange = vi.fn<(next: boolean) => void>();
    const enabled = touchBox(renderSwitch({ value: true, onValueChange }).root);
    expect(enabled?.onStartShouldSetResponder?.()).toBe(true);
    act(() => enabled?.onResponderRelease?.());
    expect(onValueChange).toHaveBeenCalledWith(false);
    const disabled = touchBox(renderSwitch({ disabled: true, onValueChange }).root);
    expect(disabled?.onStartShouldSetResponder?.()).toBe(false);
  });

  it('paints the quiet pair on a disabled on switch and keeps it on', () => {
    native.os = 'android';
    native.scheme = 'light';
    const props = nativeProps(renderSwitch({ disabled: true, value: true }).root);
    expect(props.value).toBe(true);
    expect(props.trackColor).toEqual({
      false: lightColors.ringTrack,
      true: lightColors.ringTrack,
    });
    expect(props.thumbColor).toBe(lightColors.muted);
  });

  it('paints the same quiet pair on a disabled off switch', () => {
    native.os = 'android';
    native.scheme = 'light';
    const props = nativeProps(renderSwitch({ disabled: true, value: false }).root);
    expect(props.trackColor).toEqual({
      false: lightColors.ringTrack,
      true: lightColors.ringTrack,
    });
    expect(props.thumbColor).toBe(lightColors.muted);
  });

  it('never paints a disabled grip in the scheme ink, which outranks an enabled one', () => {
    native.os = 'android';
    for (const [scheme, colors] of [
      ['light', lightColors],
      ['dark', darkColors],
    ] as const) {
      native.scheme = scheme;
      const disabled = nativeProps(renderSwitch({ disabled: true, value: true }).root);
      const enabled = nativeProps(renderSwitch({ value: true }).root);
      expect(disabled.thumbColor).not.toBe(colors.foreground);
      expect(disabled.thumbColor).not.toBe(enabled.thumbColor);
    }
  });

  it('paints one disabled pair shape in dark mode too, off the brand accent', () => {
    native.os = 'android';
    native.scheme = 'dark';
    const on = nativeProps(renderSwitch({ disabled: true, value: true }).root);
    const off = nativeProps(renderSwitch({ disabled: true, value: false }).root);
    expect(on.trackColor).toEqual({
      false: darkColors.ringTrack,
      true: darkColors.ringTrack,
    });
    expect(on.thumbColor).toBe(darkColors.mutedForeground);
    expect(off.trackColor).toEqual(on.trackColor);
    expect(off.thumbColor).toBe(on.thumbColor);
  });

  it('takes the disabled state from the accessibility state', () => {
    native.os = 'android';
    native.scheme = 'light';
    const props = nativeProps(renderSwitch({ accessibilityState: { disabled: true } }).root);
    expect(props.trackColor?.true).toBe(lightColors.ringTrack);
  });

  it('leaves the pair to the platform on iOS, which fades a disabled switch itself', () => {
    native.os = 'ios';
    native.scheme = 'light';
    const props = nativeProps(renderSwitch({ disabled: true, value: true }).root);
    expect(props.disabled).toBe(true);
    expect(props.accessibilityState?.disabled).toBe(true);
    expect(props.trackColor).toEqual({ false: lightColors.mutedSoft, true: lightColors.primary });
    expect(props.thumbColor).toBe(lightColors.primaryForeground);
  });

  it('keeps a caller pair on a disabled switch', () => {
    native.os = 'android';
    native.scheme = 'light';
    const props = nativeProps(
      renderSwitch({
        disabled: true,
        trackColor: { false: '#222222', true: '#111111' },
        thumbColor: '#333333',
      }).root
    );
    expect(props.trackColor).toEqual({ false: '#222222', true: '#111111' });
    expect(props.thumbColor).toBe('#333333');
  });
});

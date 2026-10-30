import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';

import { Switch } from './switch';

const native = vi.hoisted(() => ({ os: 'ios', scheme: 'light' as 'light' | 'dark' }));

// `vi.mock` factories are hoisted above the imports, so they cannot close over
// the palette modules; the holder is declared inside `vi.hoisted` and each test
// points it at the shipped light or dark palette before rendering.
const theme = vi.hoisted(() => {
  const colors: Record<string, string> = {};
  return { colors };
});

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
  Switch: 'Switch',
  useColorScheme: () => native.scheme,
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => theme.colors,
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

function renderSwitch(props: { disabled?: boolean; accessibilityState?: { busy?: boolean } }) {
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
  thumbColor?: string;
  trackColor?: { false?: string; true?: string };
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

  // A switch that states no colours takes them from the Android theme, which
  // tinted the track with the framework accent and left the dark off thumb
  // near-white. Both states therefore name a palette colour in each theme, and
  // the dark off track is the lighter secondary ink: the thumb is the palette's
  // near-black primary ink in that theme, so a muted track would swallow it.
  it('draws the light palette in both states', () => {
    native.scheme = 'light';
    Object.assign(theme.colors, lightColors);
    const props = nativeProps(renderSwitch({}).root);
    expect(props.trackColor).toEqual({
      false: lightColors.mutedForeground,
      true: lightColors.primary,
    });
    expect(props.thumbColor).toBe(lightColors.primaryForeground);
  });

  it('draws the dark palette in both states', () => {
    native.scheme = 'dark';
    Object.assign(theme.colors, darkColors);
    const props = nativeProps(renderSwitch({}).root);
    expect(props.trackColor).toEqual({
      false: darkColors.ink2,
      true: darkColors.primary,
    });
    expect(props.thumbColor).toBe(darkColors.primaryForeground);
  });
});

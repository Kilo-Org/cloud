import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { lightColors } from '@/lib/hooks/use-theme-colors';
import { Switch } from './switch';

const native = vi.hoisted(() => ({ os: 'ios' }));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return native.os;
    },
  },
  useColorScheme: () => 'light',
  Switch: 'Switch',
}));

type R = TestRenderer.ReactTestRenderer;
type I = TestRenderer.ReactTestInstance;

function renderSwitch(props: {
  disabled?: boolean;
  accessibilityState?: { busy?: boolean };
  trackColor?: { false?: string; true?: string };
  thumbColor?: string;
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

  it('paints the palette on the track and the grip', () => {
    native.os = 'android';
    const props = nativeProps(renderSwitch({}).root);
    expect(props.trackColor).toEqual({ false: lightColors.mutedSoft, true: lightColors.primary });
    expect(props.thumbColor).toBe(lightColors.primaryForeground);
  });

  it('keeps track and grip colors a caller supplies', () => {
    native.os = 'android';
    const props = nativeProps(
      renderSwitch({ trackColor: { false: '#222222', true: '#111111' }, thumbColor: '#333333' })
        .root
    );
    expect(props.trackColor).toEqual({ false: '#222222', true: '#111111' });
    expect(props.thumbColor).toBe('#333333');
  });
});

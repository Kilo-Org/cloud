import { createElement, type ReactElement, useState } from 'react';
import { Text as NativeText, Pressable } from 'react-native';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { nativeDimensions } from '@/test/native-dimensions.test-helpers';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button, type ButtonProps } from './button';
import { Text } from './text';

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Text: 'Text',
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#123456',
    primary: '#345678',
    primaryForeground: '#abcdef',
  }),
}));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function render(element: ReactElement) {
  act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing Button renderer');
  }
  return renderer.root.findByType(Pressable);
}

function renderButton({
  children = createElement(Text, null, 'Retry'),
  ...props
}: ButtonProps = {}) {
  return render(createElement(Button, { accessibilityLabel: 'Retry', ...props }, children));
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe('Button native target contract', () => {
  // These assertions protect compiled host dimensions; native F2 must still measure the target.
  it.each([undefined, 'default', 'lg'] as const)(
    'keeps a 44-point minimum without fixing the height for size %s',
    async size => {
      const button = renderButton({ size, variant: 'outline' });
      expect(await nativeDimensions(button.props.className as string)).toEqual([{ minHeight: 44 }]);
      expect(button.props.hitSlop).toBeUndefined();
    }
  );

  it('keeps a 36-point compact minimum plus four-point hitSlop on every edge', async () => {
    const button = renderButton({ size: 'sm' });
    expect(await nativeDimensions(button.props.className as string)).toEqual([{ minHeight: 36 }]);
    expect(button.props.hitSlop).toEqual({ top: 4, bottom: 4, left: 4, right: 4 });
  });

  it('keeps an icon target 44 points wide and tall without requiring label content', async () => {
    const button = renderButton({ size: 'icon', children: null, accessibilityLabel: 'Close' });
    expect(await nativeDimensions(button.props.className as string)).toEqual([
      { height: 44, width: 44 },
    ]);
    expect(button.props.role).toBe('button');
    expect(button.props.accessibilityLabel).toBe('Close');
  });

  it.each([0, { top: 8, bottom: 6, left: 5, right: 7 }])(
    'preserves explicit compact hitSlop %j',
    hitSlop => {
      expect(renderButton({ size: 'sm', hitSlop }).props.hitSlop).toEqual(hitSlop);
    }
  );

  it.each([
    'default',
    'destructive',
    'outline',
    'secondary',
    'ghost',
    'link',
    'accent-soft',
  ] as const)(
    'keeps the %s label and control identity while loading disables interaction',
    variant => {
      const button = renderButton({
        variant,
        loading: true,
        disabled: false,
        accessibilityState: { selected: true },
      });
      const label = button.findByType(NativeText);
      expect(label.children).toEqual(['Retry']);
      expect(button.props.role).toBe('button');
      expect(button.props.accessibilityLabel).toBe('Retry');
      expect(button.props.disabled).toBe(true);
      expect(button.props.accessibilityState).toEqual({
        selected: true,
        disabled: true,
        busy: true,
      });
      expect(button.findByType(ActivityIndicator).props.size).toBe('small');

      const ready = renderButton({
        variant,
        loading: false,
        accessibilityState: { selected: true },
      });
      expect(ready).toBe(button);
      expect(ready.findByType(NativeText)).toBe(label);
      expect(label.children).toEqual(['Retry']);
      expect(ready.findAllByType(ActivityIndicator)).toHaveLength(0);
      expect(ready.props.disabled).toBe(false);
      expect(ready.props.accessibilityState).toEqual({
        selected: true,
        disabled: false,
        busy: false,
      });
    }
  );

  it('keeps an explicitly disabled control disabled after loading ends', () => {
    renderButton({ disabled: true, loading: true });
    const button = renderButton({ disabled: true, loading: false });
    expect(button.props.disabled).toBe(true);
    expect(button.props.accessibilityState).toEqual({ disabled: true, busy: false });
    expect(button.findAllByType(ActivityIndicator)).toHaveLength(0);
    expect(button.findByType(NativeText).children).toEqual(['Retry']);
  });

  it('keeps an enabled action connected to its visible outcome', () => {
    function Action() {
      const [started, setStarted] = useState(false);
      return createElement(
        Button,
        {
          onPress: () => {
            setStarted(true);
          },
        },
        createElement(Text, null, started ? 'Started' : 'Start')
      );
    }
    const button = render(createElement(Action));
    expect(button.props.disabled).toBe(false);
    expect(button.findAllByType(ActivityIndicator)).toHaveLength(0);
    expect(button.findByType(NativeText).children).toEqual(['Start']);
    act(() => {
      (button.props.onPress as () => void)();
    });
    expect(button.findByType(NativeText).children).toEqual(['Started']);
  });
});

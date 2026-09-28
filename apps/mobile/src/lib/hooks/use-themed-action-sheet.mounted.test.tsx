import { createElement, useState } from 'react';
import { act, type ReactTestRenderer, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { darkColors, lightColors } from '@/lib/hooks/use-theme-colors';

import {
  type ThemedActionSheetOptions,
  useThemedActionSheetOptions,
} from './use-themed-action-sheet';

const appearance = vi.hoisted(() => ({
  scheme: 'dark' as 'dark' | 'light',
  bottom: 12,
}));

vi.mock('react-native', () => ({ useColorScheme: () => appearance.scheme }));
vi.mock('expo-router', () => ({ DarkTheme: {}, DefaultTheme: {} }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: appearance.bottom, left: 0, right: 0 }),
}));

const mounted: ReactTestRenderer[] = [];

/** Mounts a probe that captures every value the hook returns and can re-render. */
function mountProbe() {
  const renders: ThemedActionSheetOptions[] = [];

  function Probe() {
    const [, setTick] = useState(0);
    renders.push(useThemedActionSheetOptions());
    return createElement('Button', {
      onPress: () => {
        setTick(tick => tick + 1);
      },
    });
  }

  const holder: { current: ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    holder.current = TestRenderer.create(createElement(Probe));
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('probe did not mount');
  }
  mounted.push(renderer);

  const rerender = () => {
    act(() => {
      (renderer.root.findByType('Button').props.onPress as () => void)();
    });
  };

  return { renders, rerender };
}

beforeEach(() => {
  appearance.scheme = 'dark';
  appearance.bottom = 12;
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    renderer.unmount();
  }
});

describe('useThemedActionSheetOptions', () => {
  it('keeps one identity across re-renders while theme and inset are unchanged', () => {
    const probe = mountProbe();
    probe.rerender();
    probe.rerender();
    expect(probe.renders).toHaveLength(3);
    expect(probe.renders[1]).toBe(probe.renders[0]);
    expect(probe.renders[2]).toBe(probe.renders[0]);
  });

  it('applies the dark palette and the bottom inset', () => {
    const probe = mountProbe();
    expect(probe.renders[0]).toEqual({
      autoFocus: true,
      useModal: true,
      containerStyle: { backgroundColor: darkColors.card, paddingBottom: 12 },
      textStyle: { color: darkColors.foreground },
      titleTextStyle: { color: darkColors.mutedForeground },
      messageTextStyle: { color: darkColors.mutedForeground },
      destructiveColor: darkColors.destructive,
    });
  });

  it('returns a new identity when the theme changes', () => {
    const probe = mountProbe();
    const dark = probe.renders[0];
    appearance.scheme = 'light';
    probe.rerender();
    const light = probe.renders[1];
    expect(light).not.toBe(dark);
    expect(light?.containerStyle).toEqual({
      backgroundColor: lightColors.card,
      paddingBottom: 12,
    });
    expect(light?.textStyle).toEqual({ color: lightColors.foreground });
  });

  it('returns a new identity when the bottom inset changes', () => {
    const probe = mountProbe();
    const before = probe.renders[0];
    appearance.bottom = 24;
    probe.rerender();
    const after = probe.renders[1];
    expect(after).not.toBe(before);
    expect(after?.containerStyle).toEqual({
      backgroundColor: darkColors.card,
      paddingBottom: 24,
    });
  });
});

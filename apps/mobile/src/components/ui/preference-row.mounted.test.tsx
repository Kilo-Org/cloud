/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type LucideIcon } from '@/components/ui/icons';
import { darkColors, lightColors } from '@/lib/hooks/theme-colors.generated';
import { act, TestRenderer } from '@/test/renderer';

import { PreferenceRow } from './preference-row';

const schemeState = vi.hoisted(() => ({ current: 'light' as 'light' | 'dark' }));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  ActivityIndicator: 'ActivityIndicator',
  I18nManager: { isRTL: false },
  Pressable: 'Pressable',
  Switch: 'Switch',
  Text: 'Text',
  View: 'View',
  useColorScheme: () => schemeState.current,
}));
vi.mock('@rn-primitives/slot', () => ({ Text: 'Slot.Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({
  ActivityIndicator: 'ActivityIndicator',
}));
// The real palettes, so the switch-colour assertions below hold the token pairs
// the screen actually renders rather than values invented for the test. The
// import has to be dynamic: `vi.mock` factories are hoisted above this file's
// static imports, so a top-level `import` of the palette would not be
// initialized when the factory runs.
vi.mock('@/lib/hooks/use-theme-colors', async () => {
  const palette = await import('@/lib/hooks/theme-colors.generated');
  return {
    useThemeColors: () =>
      schemeState.current === 'dark' ? palette.darkColors : palette.lightColors,
  };
});

/** The row's icon prop takes a Lucide component; the test never inspects it. */
const Icon = (() => null) as unknown as LucideIcon;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(props: {
  value: boolean;
  disabled?: boolean;
  onValueChange: (next: boolean) => void;
  resolveValue?: () => boolean;
  subtitle?: string;
  inactiveSubtitle?: string;
}) {
  act(() => {
    const element = createElement(PreferenceRow, {
      icon: Icon,
      title: 'Let Kilo change app settings',
      subtitle: 'Applies to theme, language, notifications, models and the rest of Preferences.',
      disabled: false,
      ...props,
    });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing PreferenceRow renderer');
  }
  return renderer.root;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  schemeState.current = 'light';
});

/** WCAG relative luminance, for the switch's contrast floor. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map(at => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const linear = channels.map(channel =>
    channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  );
  const [r, g, b] = linear as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((left, right) => right - left) as [
    number,
    number,
  ];
  return (high + 0.05) / (low + 0.05);
}

describe('PreferenceRow', () => {
  it('moves the switch when the title is pressed, so a tap on the label is a tap on the control', () => {
    const seen: boolean[] = [];
    const root = renderRow({
      value: true,
      onValueChange: next => {
        seen.push(next);
      },
    });
    const label = root.find(node => Object.is(node.type, 'Pressable'));

    act(() => {
      (label.props.onPress as () => void)();
    });

    expect(seen).toEqual([false]);
  });

  it('moves the switch when the thumb is toggled, exactly once', () => {
    const seen: boolean[] = [];
    const root = renderRow({
      value: true,
      onValueChange: next => {
        seen.push(next);
      },
    });
    const toggle = root.find(node => Object.is(node.type, 'Switch'));

    act(() => {
      (toggle.props.onValueChange as (next: boolean) => void)(false);
    });

    expect(seen).toEqual([false]);
  });

  it('exposes the row as one switch carrying the title, subtitle and state', () => {
    const root = renderRow({
      value: true,
      onValueChange: () => undefined,
    });

    const switches = root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.type as string) === 'Switch' &&
        node.props.accessibilityLabel === 'Let Kilo change app settings'
    );

    const allSwitches = root.findAll(
      node => typeof node.type === 'string' && (node.type as string) === 'Switch'
    );
    expect(allSwitches).toHaveLength(1);

    expect(switches).toHaveLength(1);
    expect(switches[0]?.props.accessibilityHint).toBe(
      'Applies to theme, language, notifications, models and the rest of Preferences.'
    );
    expect(switches[0]?.props.accessibilityState).toEqual({
      disabled: false,
      busy: false,
      checked: true,
    });

    const pressable = root.find(node => Object.is(node.type, 'Pressable'));
    expect(pressable.props.accessible).toBe(false);
    expect(pressable.props.importantForAccessibility).toBe('no-hide-descendants');
  });

  it('flips the newest requested value, not the rendered one, on either control', () => {
    // The rendered value lags a store write. Three presses in a row must each
    // flip what the last one asked for, whichever control receives them.
    let requested = false;
    const seen: boolean[] = [];
    const root = renderRow({
      value: false,
      resolveValue: () => requested,
      onValueChange: next => {
        seen.push(next);
        requested = next;
      },
    });
    const label = root.find(node => Object.is(node.type, 'Pressable'));
    const toggle = root.find(node => Object.is(node.type, 'Switch'));

    act(() => {
      (label.props.onPress as () => void)();
      (toggle.props.onValueChange as (next: boolean) => void)(false);
      (label.props.onPress as () => void)();
    });

    expect(seen).toEqual([true, false, true]);
  });

  it('paints only the visible subtitle while reserving the other one invisibly', () => {
    const root = renderRow({
      value: false,
      subtitle: 'Applies now',
      inactiveSubtitle: 'Has no effect right now',
      onValueChange: () => undefined,
    });
    const textOf = (container: typeof root) =>
      container.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children);

    // The reservation holds both strings so the row can be as tall as either.
    const reservation = root.find(
      node => Object.is(node.type, 'View') && node.props.className === 'flex-row opacity-0'
    );
    expect(reservation.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(reservation.props.accessibilityElementsHidden).toBe(true);
    expect(reservation.props.pointerEvents).toBe('none');
    expect(textOf(reservation)).toEqual(['Applies now', 'Has no effect right now']);

    // Only the visible copy is painted.
    const overlay = root.find(
      node => Object.is(node.type, 'View') && node.props.className === 'absolute inset-x-0 top-0'
    );
    expect(textOf(overlay)).toEqual(['Applies now']);

    const toggle = root.find(node => Object.is(node.type, 'Switch'));
    expect(toggle.props.accessibilityHint).toBe('Applies now');
  });

  it('stacks the two reserved copies so the taller one sets the row height', () => {
    const root = renderRow({
      value: false,
      subtitle: 'Short copy',
      inactiveSubtitle: 'A noticeably longer inactive subtitle that wraps further',
      onValueChange: () => undefined,
    });
    const copies = root
      .find(node => Object.is(node.type, 'View') && node.props.className === 'flex-row opacity-0')
      .findAll(node => Object.is(node.type, 'Text'));

    expect(copies.map(node => node.props.children)).toEqual([
      'Short copy',
      'A noticeably longer inactive subtitle that wraps further',
    ]);
    // Both are full width in one row; the second is pulled back over the first,
    // so the row is as tall as the taller copy instead of the sum.
    expect(copies[0]?.props.className).toContain('w-full');
    expect(copies[1]?.props.className).toContain('-ms-[100%]');
  });

  it('keeps the light off switch at 3:1 against the row it sits on', () => {
    // Left alone on this light row, the shared switch's `mutedSoft` track sits
    // at 2.1:1 over the `#F0EEE6` card, and Android's own default before it was
    // 1.02:1, so the off control read as two barely-visible grey marks.
    schemeState.current = 'light';
    const root = renderRow({ value: false, onValueChange: () => undefined });
    const toggle = root.find(node => Object.is(node.type, 'Switch'));
    const trackColor = toggle.props.trackColor as { false: string; true: string };
    const thumbColor = toggle.props.thumbColor as string;

    expect(trackColor.false).toBe(lightColors.mutedForeground);
    expect(trackColor.true).toBe(lightColors.primary);
    expect(contrast(trackColor.false, lightColors.secondary)).toBeGreaterThanOrEqual(3);
    expect(contrast(thumbColor, trackColor.false)).toBeGreaterThanOrEqual(3);
  });

  it('leaves the dark switch to the shared component, whose off grip is light', () => {
    // The dark pair belongs to the shared `Switch`: a `foreground` grip on the
    // muted ink. Passing the light scheme's pair here would paint a near-black
    // grip on the off track and lose the knob in the dark row.
    schemeState.current = 'dark';
    const root = renderRow({ value: false, onValueChange: () => undefined });
    const toggle = root.find(node => Object.is(node.type, 'Switch'));
    const trackColor = toggle.props.trackColor as { false: string; true: string };

    expect(toggle.props.thumbColor).toBe(darkColors.foreground);
    expect(trackColor.false).toBe(darkColors.mutedForeground);
    expect(trackColor.true).toBe(darkColors.primary);
    expect(contrast(toggle.props.thumbColor as string, trackColor.false)).toBeGreaterThanOrEqual(3);
    expect(contrast(trackColor.false, darkColors.secondary)).toBeGreaterThanOrEqual(3);
  });
});

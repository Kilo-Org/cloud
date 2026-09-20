/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Globe } from '@/components/ui/icons';

import { ConfigureRow } from './configure-row';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1, width: 390, height: 844 }),
}));
vi.mock('@/components/ui/icons', () => ({ Globe: 'Globe' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'ChevronRight' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    secondaryForeground: '#F2F0EB',
    mutedForeground: '#8A8680',
    destructive: '#F28B7A',
  }),
}));

/**
 * The account settings list (Language / Trusted hosts / Passkeys / Device
 * sessions) once hashed each row title into the agent hue ramp, so the list
 * showed three different accent tints (olive, blue, purple). Passkeys and
 * Device sessions collided on the same hue, so a test over three titles could
 * pass while a fourth row still rendered a hashed tint — every account row is
 * named here.
 */
const ACCOUNT_ROW_TITLES = ['Language', 'Trusted hosts', 'Passkeys', 'Device sessions'];

/** The Preferences hub rows all render through this same component. */
const PREFERENCES_HUB_ROW_TITLES = [
  'General',
  'Voice input',
  'Translate tool summaries',
  'Account',
  'Notifications',
];

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow(props: { title: string; tone?: 'good' | 'warn' | 'danger' }) {
  act(() => {
    const element = createElement(ConfigureRow, { ...props, icon: Globe });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing ConfigureRow renderer');
  }
  const root = renderer.root;
  const tile = root.find(
    node =>
      typeof node.props.className === 'string' && node.props.className.includes('h-[30px] w-[30px]')
  );
  const icon = root.find(node => Object.is(node.type, 'Globe'));
  return {
    tileClassName: tile.props.className as string,
    iconColor: icon.props.color as string,
  };
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ConfigureRow icon tile', () => {
  it.each(ACCOUNT_ROW_TITLES)('gives the %s account row the shared neutral tile', title => {
    const row = renderRow({ title });

    expect(row.tileClassName).toContain('bg-hair-soft');
    expect(row.tileClassName).toContain('border-border');
    expect(row.tileClassName).not.toContain('agent-');
    expect(row.iconColor).toBe('#F2F0EB');
  });

  it('gives the account and Preferences hub rows one identical tile', () => {
    const tiles = [...ACCOUNT_ROW_TITLES, ...PREFERENCES_HUB_ROW_TITLES].map(
      title => renderRow({ title }).tileClassName
    );

    expect(new Set(tiles).size).toBe(1);
  });

  it('still lets a semantic tone override the neutral tile', () => {
    const neutral = renderRow({ title: 'Language' });
    const danger = renderRow({ title: 'Language', tone: 'danger' });

    expect(danger.tileClassName).toContain('bg-danger-tile-bg');
    expect(danger.iconColor).toBe('#F28B7A');
    expect(danger.iconColor).not.toBe(neutral.iconColor);
  });
});

/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Globe } from '@/components/ui/icons';
import { act, TestRenderer } from '@/test/renderer';

import { ConfigureRow } from './configure-row';

const windowDims = vi.hoisted(() => ({ width: 390, height: 844, fontScale: 1, scale: 2 }));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  useWindowDimensions: () => windowDims,
}));
vi.mock('@/components/ui/icons', () => ({ Globe: 'Globe' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'ChevronRight',
}));
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

function renderRow(props: { title?: string; tone?: 'good' | 'warn' | 'danger' } = {}) {
  act(() => {
    const element = createElement(ConfigureRow, {
      icon: Globe,
      title: props.title ?? 'General',
      subtitle: 'Transcribe',
      onPress: () => undefined,
      ...(props.tone === undefined ? {} : { tone: props.tone }),
    });
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing ConfigureRow renderer');
  }
  return renderer.root;
}

/** The classes of the row body: the one View that carries the row padding. */
function rowClasses(root: TestRenderer.ReactTestInstance): string[] {
  const body = root.find(
    node => Object.is(node.type, 'View') && String(node.props.className).includes('py-3')
  );
  return String(body.props.className).split(' ');
}

/** The shared icon tile and its stroke for the mounted row. */
function tileOf(root: TestRenderer.ReactTestInstance): {
  tileClassName: string;
  iconColor: string;
} {
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
  windowDims.width = 390;
  windowDims.fontScale = 1;
});

describe('ConfigureRow mounted layout', () => {
  // A 160 dp window leaves the text block between the icon tile and the
  // chevron too little room for one word, and Android broke it mid-word
  // ("Gene ral" / "Trans cribe", e1-settings, 2026-09-21). Stacking hands the
  // title and subtitle the row's full width.
  it('stacks the icon above the title in a narrow window', () => {
    windowDims.width = 160;
    const classes = rowClasses(renderRow());
    expect(classes).toEqual(expect.arrayContaining(['gap-2', 'py-3']));
    expect(classes).not.toContain('flex-row');
  });

  it('keeps the side-by-side row at phone widths', () => {
    const classes = rowClasses(renderRow());
    expect(classes).toEqual(expect.arrayContaining(['flex-row', 'items-center', 'gap-3']));
    expect(classes).not.toContain('gap-2');
  });

  it('still stacks at the large-font-scale threshold', () => {
    windowDims.fontScale = 1.8;
    expect(rowClasses(renderRow())).not.toContain('flex-row');
  });
});

describe('ConfigureRow icon tile', () => {
  it.each(ACCOUNT_ROW_TITLES)('gives the %s account row the shared neutral tile', title => {
    const row = tileOf(renderRow({ title }));

    expect(row.tileClassName).toContain('bg-hair-soft');
    expect(row.tileClassName).toContain('border-border');
    expect(row.tileClassName).not.toContain('agent-');
    expect(row.iconColor).toBe('#F2F0EB');
  });

  it('gives the account and Preferences hub rows one identical tile', () => {
    const tiles = [...ACCOUNT_ROW_TITLES, ...PREFERENCES_HUB_ROW_TITLES].map(
      title => tileOf(renderRow({ title })).tileClassName
    );

    expect(new Set(tiles).size).toBe(1);
  });

  it('still lets a semantic tone override the neutral tile', () => {
    const neutral = tileOf(renderRow({ title: 'Language' }));
    const danger = tileOf(renderRow({ title: 'Language', tone: 'danger' }));

    expect(danger.tileClassName).toContain('bg-danger-tile-bg');
    expect(danger.iconColor).toBe('#F28B7A');
    expect(danger.iconColor).not.toBe(neutral.iconColor);
  });
});

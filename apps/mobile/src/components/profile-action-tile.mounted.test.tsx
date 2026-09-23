/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageSquare, SlidersHorizontal } from '@/components/ui/icons';
import { agentColor, rowTint, toneColor } from '@/lib/agent-color';

import { ActionTile } from './profile-action-tile';
import { ConfigureRow } from './ui/configure-row';

// Every hue key a Tint can carry, so the mocked theme resolves any tint.
const themeColors = vi.hoisted(() => {
  const colors: Record<string, string> = {
    agentCloud: '#agent-cloud',
    agentYuki: '#agent-yuki',
    agentKilocode: '#agent-kilocode',
    agentCoral: '#agent-coral',
    agentSky: '#agent-sky',
    agentWorkclaw: '#agent-workclaw',
    good: '#good',
    warn: '#warn',
    destructive: '#destructive',
    mutedForeground: '#muted-foreground',
    secondaryForeground: '#secondary-foreground',
    rowHoney: '#row-honey',
    rowGold: '#row-gold',
    rowLime: '#row-lime',
    rowSage: '#row-sage',
    rowMoss: '#row-moss',
    rowFern: '#row-fern',
  };
  return colors;
});

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  useWindowDimensions: () => ({ fontScale: 1 }),
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  MessageSquare: 'MessageSquare',
  SlidersHorizontal: 'SlidersHorizontal',
}));
vi.mock('@/components/ui/directional-icons', () => ({ DirectionalChevronRight: 'ChevronRight' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => themeColors }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function render(element: ReturnType<typeof createElement>): TestRenderer.ReactTestInstance {
  act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing ActionTile renderer');
  }
  return renderer.root;
}

/** The 30×30 leading icon tile host View. */
function tileClassName(root: TestRenderer.ReactTestInstance): string {
  const tiles = root.findAll(
    node =>
      Object.is(node.type, 'View') &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('h-[30px]')
  );
  expect(tiles).toHaveLength(1);
  return tiles[0]?.props.className as string;
}

function iconNode(root: TestRenderer.ReactTestInstance, type: string) {
  return root.find(node => Object.is(node.type, type));
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ActionTile mounted treatment', () => {
  it('leads the row with the shared tinted icon tile', () => {
    const root = render(
      createElement(ActionTile, {
        icon: MessageSquare,
        label: 'Feedback',
        hue: 'fern',
        onPress: () => undefined,
      })
    );
    const className = tileClassName(root);
    const tint = rowTint('fern');
    expect(className).toContain('h-[30px]');
    expect(className).toContain('w-[30px]');
    expect(className).toContain('rounded-lg');
    expect(className).toContain('border');
    expect(className).toContain(tint.tileBgClass);
    expect(className).toContain(tint.tileBorderClass);
  });

  it('renders the icon at the tile size in the tint hue', () => {
    const root = render(
      createElement(ActionTile, {
        icon: MessageSquare,
        label: 'Feedback',
        hue: 'fern',
        onPress: () => undefined,
      })
    );
    const icon = iconNode(root, 'MessageSquare');
    expect(icon.props.size).toBe(16);
    expect(icon.props.color).toBe(themeColors[rowTint('fern').hueThemeKey]);
  });

  it('renders the same tint for the same row in English and Serbian', () => {
    const label = 'Feedback';
    const english = render(
      createElement(ActionTile, {
        icon: MessageSquare,
        label,
        hue: 'fern',
        onPress: () => undefined,
      })
    );
    const englishClassName = tileClassName(english);
    const englishColor = iconNode(english, 'MessageSquare').props.color as string;

    const serbian = render(
      createElement(ActionTile, {
        icon: MessageSquare,
        label: 'Povratne informacije',
        hue: 'fern',
        onPress: () => undefined,
      })
    );
    const serbianClassName = tileClassName(serbian);
    const serbianColor = iconNode(serbian, 'MessageSquare').props.color as string;

    // The colour is chosen by the destination, never hashed from the label:
    // the same row renders the same tile in every language.
    expect(serbianClassName).toBe(englishClassName);
    expect(serbianColor).toBe(englishColor);
    expect(englishColor).not.toBe(themeColors.secondaryForeground);
    expect(englishColor).not.toBe(themeColors[agentColor(label).hueThemeKey]);
  });

  it('tints the destructive row tile and keeps the red label', () => {
    const root = render(
      createElement(ActionTile, {
        icon: MessageSquare,
        label: 'Delete Account',
        hue: 'fern',
        destructive: true,
        onPress: () => undefined,
      })
    );
    const className = tileClassName(root);
    const tint = toneColor('danger');
    expect(className).toContain(tint.tileBgClass);
    expect(className).toContain(tint.tileBorderClass);
    expect(iconNode(root, 'MessageSquare').props.color).toBe(themeColors.destructive);
    const label = root.find(
      node => Object.is(node.type, 'Text') && node.children.includes('Delete Account')
    );
    expect(label.props.className).toContain('text-destructive');
  });

  it('keeps the row rhythm and accessibility contract', () => {
    const root = render(
      createElement(ActionTile, {
        icon: MessageSquare,
        label: 'Feedback',
        hue: 'fern',
        onPress: () => undefined,
      })
    );
    const pressable = root.find(node => Object.is(node.type, 'Pressable'));
    const className = pressable.props.className as string;
    expect(className).toContain('px-3');
    expect(className).toContain('py-3');
    expect(className).toContain('bg-secondary');
    expect(className).toContain('active:opacity-70');
    expect(pressable.props.accessibilityLabel).toBe('Feedback');
    expect(pressable.props.accessibilityRole).toBe('button');
  });

  it('gives ConfigureRow and ActionTile the identical tile treatment for a semantic tone', () => {
    // An untoned ConfigureRow is deliberately neutral now — a settings list must
    // not hash each row title into the agent hue ramp (configure-row.mounted.test
    // .tsx locks that) — so the shared treatment this test guards is the tone
    // path: `danger` on the settings row resolves through the same `toneColor`
    // the destructive profile action row uses.
    const configureRoot = render(
      createElement(ConfigureRow, { icon: SlidersHorizontal, title: 'Feedback', tone: 'danger' })
    );
    const configureTile = tileClassName(configureRoot);

    const actionRoot = render(
      createElement(ActionTile, {
        icon: MessageSquare,
        label: 'Feedback',
        hue: 'fern',
        destructive: true,
        onPress: () => undefined,
      })
    );
    const actionTile = tileClassName(actionRoot);

    expect(configureTile).toBe(actionTile);
  });
});

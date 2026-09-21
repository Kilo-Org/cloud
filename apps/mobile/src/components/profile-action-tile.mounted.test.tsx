/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageSquare, SlidersHorizontal } from '@/components/ui/icons';
import { agentColor, toneColor } from '@/lib/agent-color';

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
        onPress: () => undefined,
      })
    );
    const className = tileClassName(root);
    const tint = agentColor('Feedback');
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
        onPress: () => undefined,
      })
    );
    const icon = iconNode(root, 'MessageSquare');
    expect(icon.props.size).toBe(16);
    expect(icon.props.color).toBe(themeColors[agentColor('Feedback').hueThemeKey]);
  });

  it('tints the destructive row tile and keeps the red label', () => {
    const root = render(
      createElement(ActionTile, {
        icon: MessageSquare,
        label: 'Delete Account',
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

  it('gives ConfigureRow and ActionTile the identical tile treatment', () => {
    const configureRoot = render(
      createElement(ConfigureRow, { icon: SlidersHorizontal, title: 'Feedback' })
    );
    const configureTile = tileClassName(configureRoot);

    const actionRoot = render(
      createElement(ActionTile, {
        icon: MessageSquare,
        label: 'Feedback',
        onPress: () => undefined,
      })
    );
    const actionTile = tileClassName(actionRoot);

    expect(configureTile).toBe(actionTile);
  });
});

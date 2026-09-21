/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { type LucideIcon } from '@/components/ui/icons';

import { ConfigureRow } from './configure-row';

const windowDims = vi.hoisted(() => ({ width: 390, height: 844, fontScale: 1, scale: 2 }));

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  useWindowDimensions: () => windowDims,
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'ChevronRight',
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    mutedForeground: '#666666',
    accentForeground: '#111111',
    primary: '#111111',
    foreground: '#111111',
  }),
}));

const Icon = (() => null) as unknown as LucideIcon;

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderRow() {
  act(() => {
    const element = createElement(ConfigureRow, {
      icon: Icon,
      title: 'General',
      subtitle: 'Transcribe',
      onPress: () => undefined,
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

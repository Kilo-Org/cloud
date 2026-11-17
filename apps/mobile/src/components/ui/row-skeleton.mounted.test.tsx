/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { ROW_FRAME_CLASS, ROW_TILE_CLASS } from './row-frame';
import { RowSkeleton } from './row-skeleton';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
// The frame constants are the point of this test; only its module's leaf
// dependencies are stubbed, so the skeleton is checked against the real one.
vi.mock('@/components/ui/icon-tile', () => ({ IconTile: 'IconTile' }));
vi.mock('@/components/ui/icons', () => ({}));
vi.mock('@/components/ui/directional-icons', () => ({}));
vi.mock('@/components/ui/row-check', () => ({ RowCheck: 'RowCheck' }));
vi.mock('@/components/ui/row-chevron', () => ({ RowChevron: 'RowChevron' }));
vi.mock('@/components/ui/switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderSkeleton(props: Readonly<Record<string, unknown>>) {
  act(() => {
    const element = createElement(RowSkeleton, props);
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing RowSkeleton renderer');
  }
  return renderer.root;
}

function classesOf(node: TestRenderer.ReactTestInstance): string[] {
  return String(node.props.className ?? '').split(' ');
}

function skeletons(root: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return root.findAllByType('Skeleton' as never);
}

function first(node: TestRenderer.ReactTestInstance | undefined): TestRenderer.ReactTestInstance {
  if (node === undefined) {
    throw new Error('Missing node');
  }
  return node;
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('RowSkeleton', () => {
  it('renders the row frame it stands in for', () => {
    const frame = renderSkeleton({});
    const classes = classesOf(frame);

    for (const name of ROW_FRAME_CLASS.split(' ')) {
      expect(classes).toContain(name);
    }
    expect(classes.some(name => name.startsWith('border-'))).toBe(false);
  });

  it('reserves the leading tile at the tile primitive size', () => {
    const bars = skeletons(renderSkeleton({ tile: true }));

    expect(classesOf(first(bars[0]))).toEqual(
      expect.arrayContaining(ROW_TILE_CLASS.split(' '))
    );
    expect(skeletons(renderSkeleton({}))).toHaveLength(1);
  });

  it('reserves two text lines for a row with a subtitle', () => {
    expect(skeletons(renderSkeleton({ subtitle: true }))).toHaveLength(2);
    expect(skeletons(renderSkeleton({}))).toHaveLength(1);
  });

  it('takes an explicit line count for a two-line row', () => {
    expect(skeletons(renderSkeleton({ lines: 2 }))).toHaveLength(2);
    expect(skeletons(renderSkeleton({ lines: 3 }))).toHaveLength(3);
  });

  it('reserves the 48pt trailing icon target', () => {
    const bars = skeletons(renderSkeleton({ trailingControl: true }));
    const control = bars[bars.length - 1];

    expect(classesOf(first(control))).toEqual(
      expect.arrayContaining(['h-[48px]', 'w-[48px]', 'shrink-0'])
    );
  });

  it('reserves the switch a preference row ends in', () => {
    const bars = skeletons(renderSkeleton({ trailing: 'switch' }));
    const toggle = bars[bars.length - 1];

    expect(classesOf(first(toggle))).toEqual(
      expect.arrayContaining(['rounded-full', 'shrink-0'])
    );
  });

  it('keeps the flat-list session shape', () => {
    const classes = classesOf(renderSkeleton({ variant: 'session', last: false }));

    expect(classes).toEqual(expect.arrayContaining(['flex-row', 'px-4', 'py-3']));
    // The strip, the eyebrow, the title and the meta bar.
    expect(skeletons(renderSkeleton({ variant: 'session', last: false }))).toHaveLength(3);
  });
});

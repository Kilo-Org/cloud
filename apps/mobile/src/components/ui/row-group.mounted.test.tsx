/* eslint-disable typescript-eslint/no-deprecated -- DOM-free mounted React Native layout regression tests. */
import { type ReactElement, createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

import { RowGroup, RowGroupItem } from './row-group';

vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

function renderGroup(element: ReactElement) {
  act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
  if (!renderer) {
    throw new Error('Missing RowGroup renderer');
  }
  return renderer.root;
}

function classesOf(node: TestRenderer.ReactTestInstance): string[] {
  return String(node.props.className ?? '').split(' ');
}

function first(node: TestRenderer.ReactTestInstance | undefined): TestRenderer.ReactTestInstance {
  if (node === undefined) {
    throw new Error('Missing node');
  }
  return node;
}

function item(position: 'only' | 'first' | 'middle' | 'last', leadingTile = false) {
  return createElement(
    RowGroupItem,
    { position, leadingTile },
    createElement('Text', null, `${position}-row`)
  );
}

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('RowGroup', () => {
  it('draws the surface and a separator between rows only', () => {
    const root = renderGroup(
      createElement(
        RowGroup,
        { leadingTile: true },
        createElement('Text', null, 'first-row'),
        createElement('Text', null, 'last-row')
      )
    );
    const group = root.findAll(node => Object.is(node.type, 'View'))[0];
    const separators = root.findAll(
      node => Object.is(node.type, 'View') && classesOf(node).includes('border-b-[0.5px]')
    );

    expect(classesOf(first(group))).toEqual(
      expect.arrayContaining(['overflow-hidden', 'rounded-xl', 'bg-secondary'])
    );
    expect(separators).toHaveLength(1);
    expect(classesOf(first(separators[0]))).toContain('ms-[54.5px]');
  });
});

describe('RowGroupItem', () => {
  it('rounds both ends when it is the whole section', () => {
    const root = renderGroup(item('only'));
    const cell = root.findAll(node => Object.is(node.type, 'View'))[0];
    const classes = classesOf(first(cell));

    expect(classes).toEqual(
      expect.arrayContaining(['overflow-hidden', 'bg-secondary', 'rounded-xl'])
    );
    expect(root.findAll(node => classesOf(node).includes('border-b-[0.5px]'))).toHaveLength(0);
  });

  it.each<{
    position: 'first' | 'middle' | 'last';
    rounded: string;
    separator: boolean;
  }>([
    { position: 'first', rounded: 'rounded-t-xl', separator: true },
    { position: 'middle', rounded: '', separator: true },
    { position: 'last', rounded: 'rounded-b-xl', separator: false },
  ])('draws $position at its place in the section', ({ position, rounded, separator }) => {
    const root = renderGroup(item(position));
    const cell = root.findAll(node => Object.is(node.type, 'View'))[0];
    const classes = classesOf(first(cell));
    const separators = root.findAll(node => classesOf(node).includes('border-b-[0.5px]'));

    expect(classes).toContain('bg-secondary');
    if (rounded === '') {
      expect(classes.some(name => name.startsWith('rounded-'))).toBe(false);
    } else {
      expect(classes).toContain(rounded);
    }
    expect(separators).toHaveLength(separator ? 1 : 0);
  });

  it('insets the separator after a leading tile', () => {
    const tiled = renderGroup(item('first', true));
    const tiledSeparator = classesOf(first(tiled.findAll(node => classesOf(node).includes('border-b-[0.5px]'))[0]));
    const dotted = renderGroup(item('first', false));
    const dottedSeparator = classesOf(first(dotted.findAll(node => classesOf(node).includes('border-b-[0.5px]'))[0]));

    expect(tiledSeparator).toContain('ms-[54.5px]');
    expect(dottedSeparator).toContain('ms-4');
  });
});

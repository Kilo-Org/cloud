/**
 * Behaviour tests for the FlashList patch carried in
 * `patches/@shopify+flash-list@2.3.3.patch`, at the collection the list renders
 * its rows through.
 *
 * The layout table and the render stack are separate: a commit can ask the
 * collection to re-render for rows it already drew, and a stack entry can still
 * name an index the table no longer holds. The collection is mounted here with
 * the accessor the list now hands it, so both regressions fail again if the
 * patch is dropped or an upgrade reverts it.
 */
import { createElement, createRef, type ReactElement, type RefObject } from 'react';
import {
  type RVLayout,
  ViewHolderCollection,
  type ViewHolderCollectionProps,
  type ViewHolderCollectionRef,
} from '@shopify/flash-list/dist/recyclerview/ViewHolderCollection';
import { describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';

vi.mock('react-native', () => ({
  Animated: { View: 'AnimatedView' },
  I18nManager: { isRTL: false },
  View: 'View',
}));

const CONTAINER = { width: 320, height: 600 };

function box(y: number, height: number): RVLayout {
  // `enforcedHeight` makes the cell carry its measured height, so a test can
  // read the box the collection drew.
  return { x: 0, y, width: CONTAINER.width, height, enforcedHeight: true };
}

type Row = { key: string };

type CollectionOptions = {
  rows: Row[];
  stack: [string, number][];
  layouts: Map<number, RVLayout>;
  onRender: () => void;
};

/**
 * One collection over the layouts the test holds. `getLayout` answers the way
 * the patched list does: undefined for an index the table no longer holds,
 * instead of throwing.
 */
function collectionOf(
  options: CollectionOptions,
  ref: RefObject<ViewHolderCollectionRef | null>
): ReactElement {
  const props: ViewHolderCollectionProps<Row> = {
    data: options.rows,
    renderStack: new Map(options.stack.map(([key, index]) => [key, { index }])),
    getLayout: (index: number) => options.layouts.get(index),
    viewHolderCollectionRef: ref,
    refHolder: new Map(),
    onSizeChanged: () => undefined,
    renderItem: ({ item }: { item: Row }) => createElement('Row', null, item.key),
    extraData: undefined,
    // The collection asks for its container once per render, so this counts
    // the renders.
    getChildContainerLayout: () => {
      options.onRender();
      return CONTAINER;
    },
    onCommitLayoutEffect: () => undefined,
    onCommitEffect: () => undefined,
    horizontal: false,
    getAdjustmentMargin: () => 0,
    currentStickyIndex: -1,
    hideStickyHeaderRelatedCell: false,
    isInLastRow: () => false,
    inverted: false,
  };
  return createElement(ViewHolderCollection, props);
}

/** One rendered cell: the index it was drawn for and the box it was given. */
type CellBox = { index: number; top: number; height: number };

function cellsOf(renderer: TestRenderer.ReactTestRenderer): CellBox[] {
  return renderer.root
    .findAllByType('View')
    .filter(node => node.props.index !== undefined)
    .map(node => {
      const index = node.props.index as number;
      const style = node.props.style as { top?: number; height?: number };
      return { index, top: style.top ?? 0, height: style.height ?? 0 };
    });
}

/**
 * Mount one collection. The renderer lives in a holder because the mount runs
 * inside `act`, and the component tree is not readable until it returns.
 */
async function mountCollection(
  options: CollectionOptions,
  ref: RefObject<ViewHolderCollectionRef | null>
): Promise<TestRenderer.ReactTestRenderer> {
  const holder: { current: TestRenderer.ReactTestRenderer | null } = { current: null };
  await act(async () => {
    await Promise.resolve();
    holder.current = TestRenderer.create(collectionOf(options, ref));
  });
  if (holder.current === null) {
    throw new Error('the collection did not render');
  }
  return holder.current;
}

describe('FlashList ViewHolderCollection over the layout table', () => {
  it('draws nothing for a render stack entry the layout table no longer holds', async () => {
    const ref = createRef<ViewHolderCollectionRef>();
    const rowHeight = 50;
    const layouts = new Map<number, RVLayout>([
      [0, box(0, rowHeight)],
      [1, box(rowHeight, rowHeight)],
    ]);

    // The list shrank to two rows while the render stack still names the third.
    const renderer = await mountCollection(
      {
        rows: [{ key: 'a' }, { key: 'b' }],
        stack: [
          ['a', 0],
          ['b', 1],
          ['stale', 2],
        ],
        layouts,
        onRender: () => undefined,
      },
      ref
    );

    const cells = cellsOf(renderer);
    expect(cells.map(cell => cell.index)).toEqual([0, 1]);
    // The stale entry used to draw an empty box at the container's origin.
    expect(cells.map(cell => cell.top)).toEqual([0, rowHeight]);

    renderer.unmount();
  });

  it('forces a re-render only for a layout table the collection has not drawn', async () => {
    const ref = createRef<ViewHolderCollectionRef>();
    let renders = 0;
    const layouts = new Map<number, RVLayout>([
      [0, box(0, 50)],
      [1, box(50, 50)],
    ]);

    const renderer = await mountCollection(
      {
        rows: [{ key: 'a' }, { key: 'b' }],
        stack: [
          ['a', 0],
          ['b', 1],
        ],
        layouts,
        onRender: () => {
          renders += 1;
        },
      },
      ref
    );

    const afterMount = renders;
    expect(afterMount).toBeGreaterThan(0);

    // The first commit is what paints the rows and reports the collection's
    // layout, so it always runs.
    act(() => {
      ref.current?.commitLayout();
    });
    const afterFirstCommit = renders;
    expect(afterFirstCommit).toBeGreaterThan(afterMount);

    // The list asks again on every one of its own commits. An unchanged table
    // is the case that used to schedule another render, and then another.
    for (let pass = 0; pass < 5; pass += 1) {
      act(() => {
        ref.current?.commitLayout();
      });
    }
    expect(renders).toBe(afterFirstCommit);

    // A row that reports a new size changes the table, so the collection has to
    // draw it.
    layouts.set(0, box(0, 120));
    act(() => {
      ref.current?.commitLayout();
    });
    expect(renders).toBeGreaterThan(afterFirstCommit);
    expect(cellsOf(renderer).map(cell => cell.height)).toEqual([120, 50]);

    renderer.unmount();
  });
});

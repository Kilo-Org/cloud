/**
 * Dependency-contract test for the FlashList patch carried in
 * `patches/@shopify+flash-list@2.3.3.patch`.
 *
 * The session list's rows shrink: pagination, search, a filter change,
 * deletion, pull-to-refresh, and the reserved skeleton rows swapping to the real
 * ones. FlashList takes its row key and item type from an index that comes from
 * the layout manager, so for one commit that index can still point past the end
 * of the rows that arrived. `RenderStackManager.sync` bounded its retained-key
 * pass by the data length but not its two engaged-index passes, and
 * `RecyclerViewManager` read `data[index]` unguarded for the key (also used by
 * the maintainVisibleContentPosition anchor) and the item type. The list's
 * `keyExtractor` then read `.key` of an undefined row: "Cannot read property
 * 'key' of undefined" (explorer finding on the Android build).
 *
 * The patch skips engaged indices past the data length, and answers an
 * out-of-range key and item type without calling the list's callbacks. This test
 * runs the real patched modules, so it fails again if the patch is dropped or an
 * upgrade reintroduces an unguarded read.
 */
import { ConsecutiveNumbers } from '@shopify/flash-list/dist/recyclerview/helpers/ConsecutiveNumbers';
import { RecyclerViewManager } from '@shopify/flash-list/dist/recyclerview/RecyclerViewManager';
import { type RecyclerViewProps } from '@shopify/flash-list/dist/recyclerview/RecyclerViewProps';
import { RenderStackManager } from '@shopify/flash-list/dist/recyclerview/RenderStackManager';
import { describe, expect, it, vi } from 'vitest';

// The manager reaches the list's own key and type reads. Its module graph also
// loads a React Native measurement helper, which this node project cannot parse;
// only `PixelRatio` is read from that import, and no test here measures a view.
vi.mock('react-native', () => ({ PixelRatio: { roundToNearestPixel: (value: number) => value } }));

type Row = { key: string; kind: string };

/** Every row the list callbacks were given, so a shrink shows up as undefined. */
type CallLog = { keys: (Row | undefined)[]; types: (Row | undefined)[] };

function rows(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `row-${index}`,
    kind: index === 0 ? 'header' : 'session',
  }));
}

/**
 * A manager over `data`. The library's props type requires the whole list
 * surface; this test drives only the reads guarded by the patch, so the partial
 * props are cast once, here, with that limit stated.
 */
function managerFor(data: readonly Row[], calls: CallLog): RecyclerViewManager<Row> {
  const props: Partial<RecyclerViewProps<Row>> = {
    data: [...data],
    keyExtractor: (row: Row | undefined) => {
      calls.keys.push(row);
      return row?.key ?? 'missing';
    },
    getItemType: (row: Row | undefined) => {
      calls.types.push(row);
      return row?.kind;
    },
  };
  return new RecyclerViewManager(props as RecyclerViewProps<Row>);
}

/** Fill the manager with the keys a longer list produced. */
function prime(manager: RenderStackManager, count: number): void {
  const data = rows(count);
  manager.sync(
    (index: number) => data[index]?.key ?? 'missing',
    (index: number) => data[index]?.kind ?? 'missing',
    new ConsecutiveNumbers(0, count - 1),
    count
  );
}

describe('FlashList RenderStackManager engaged indices past the data length', () => {
  it('skips an engaged range that outlived a shrink instead of reading the rows', () => {
    const manager = new RenderStackManager();
    prime(manager, 12);

    // The rows shrink to three, while the engaged range still names 8..11.
    const data = rows(3);
    const read: number[] = [];
    const getStableId = (index: number) => {
      read.push(index);
      return data[index]?.key ?? 'missing';
    };

    expect(() => {
      manager.sync(
        getStableId,
        (index: number) => data[index]?.kind ?? 'missing',
        new ConsecutiveNumbers(8, 11),
        data.length
      );
    }).not.toThrow();

    expect(read).not.toContain(8);
    expect(read.every(index => index < data.length)).toBe(true);
    for (const entry of manager.getRenderStack().values()) {
      expect(entry.index).toBeLessThan(data.length);
    }
  });

  it('keeps the rows still in range when the engaged range straddles the end', () => {
    const manager = new RenderStackManager();
    prime(manager, 12);

    const data = rows(3);
    manager.sync(
      (index: number) => data[index]?.key ?? 'missing',
      (index: number) => data[index]?.kind ?? 'missing',
      new ConsecutiveNumbers(2, 6),
      data.length
    );

    const stableIds = [...manager.getRenderStack().values()].map(entry => entry.stableId);
    expect(stableIds).toContain('row-2');
    expect(stableIds.every(stableId => data.some(row => row.key === stableId))).toBe(true);
  });

  it('never hands a key read an undefined row when the range outlives the shrink', () => {
    // The shape of the original crash: the key read calls the list's
    // keyExtractor, which dereferences the row it is given.
    const manager = new RenderStackManager();
    prime(manager, 12);

    const data = rows(3);
    const read: (Row | undefined)[] = [];
    manager.sync(
      (index: number) => {
        const row = data[index];
        read.push(row);
        return row?.key ?? 'missing';
      },
      (index: number) => data[index]?.kind ?? 'missing',
      new ConsecutiveNumbers(0, 11),
      data.length
    );

    expect(read.length).toBeGreaterThan(0);
    expect(read.every(row => row !== undefined)).toBe(true);
  });
});

describe('FlashList RecyclerViewManager reads past the data length', () => {
  it('answers with the index for a key read past the rows, without calling keyExtractor', () => {
    // The maintainVisibleContentPosition anchor reads this key straight off the
    // engaged or first-visible index, so a shrink leaves it naming an index the
    // rows no longer have.
    const calls: CallLog = { keys: [], types: [] };
    const manager = managerFor(rows(3), calls);

    expect(manager.getDataKey(7)).toBe('7');
    expect(calls.keys).toEqual([]);
    expect(manager.getDataKey(2)).toBe('row-2');
  });

  it('keeps both reads safe through the render-stack sync the list runs', () => {
    // `updateRenderStack` is what the list calls with its engaged range, and it
    // passes the key and item-type reads to the sync.
    const calls: CallLog = { keys: [], types: [] };
    const manager = managerFor(rows(3), calls);
    // The sync is private in the library's types, and this is its only entry
    // point from the list, so a named cast is the one way to reach it here.
    const sync = manager as unknown as {
      updateRenderStack: (indices: ConsecutiveNumbers) => void;
    };

    expect(() => {
      sync.updateRenderStack(new ConsecutiveNumbers(0, 9));
    }).not.toThrow();
    expect(calls.keys.length).toBeGreaterThan(0);
    expect(calls.keys.every(row => row !== undefined)).toBe(true);
    expect(calls.types.every(row => row !== undefined)).toBe(true);
  });

  it('answers the default item type past the rows instead of calling getItemType', () => {
    // The layout manager asks for an item type to estimate a row height, and a
    // shrink can leave it estimating an index the rows no longer have.
    const calls: CallLog = { keys: [], types: [] };
    const manager = managerFor(rows(3), calls);
    // The type read is private in the library's types; the layout manager is its
    // only caller, so a named cast is the one way to test that seam.
    const read = manager as unknown as { getItemType: (index: number) => string };

    expect(read.getItemType(9)).toBe('default');
    expect(calls.types).toEqual([]);
    expect(read.getItemType(2)).toBe('session');
  });
});

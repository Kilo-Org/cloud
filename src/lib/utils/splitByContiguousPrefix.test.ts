import { splitByContiguousPrefix } from './splitByContiguousPrefix';

const isEven = (n: number) => n % 2 === 0;

describe('splitByContiguousPrefix', () => {
  it('returns empty arrays for empty input', () => {
    expect(splitByContiguousPrefix([], isEven)).toEqual({
      staticItems: [],
      dynamicItems: [],
    });
  });

  it('puts all items in static when every item satisfies the predicate', () => {
    expect(splitByContiguousPrefix([2, 4, 6], isEven)).toEqual({
      staticItems: [2, 4, 6],
      dynamicItems: [],
    });
  });

  it('puts all items in dynamic when the first item fails the predicate', () => {
    expect(splitByContiguousPrefix([1, 2, 4], isEven)).toEqual({
      staticItems: [],
      dynamicItems: [1, 2, 4],
    });
  });

  it('splits at the first failing item', () => {
    expect(splitByContiguousPrefix([2, 4, 1, 6], isEven)).toEqual({
      staticItems: [2, 4],
      dynamicItems: [1, 6],
    });
  });

  it('keeps a single passing item as the prefix', () => {
    expect(splitByContiguousPrefix([2, 1, 4], isEven)).toEqual({
      staticItems: [2],
      dynamicItems: [1, 4],
    });
  });

  it('handles a single failing item', () => {
    expect(splitByContiguousPrefix([1], isEven)).toEqual({
      staticItems: [],
      dynamicItems: [1],
    });
  });

  it('handles a single passing item', () => {
    expect(splitByContiguousPrefix([2], isEven)).toEqual({
      staticItems: [2],
      dynamicItems: [],
    });
  });

  it('does not reorder items — dynamic preserves original order', () => {
    //  complete, streaming, complete, streaming
    const items = ['c1', 'S1', 'c2', 'S2'];
    const complete = new Set(['c1', 'c2']);

    const result = splitByContiguousPrefix(items, i => complete.has(i));
    expect(result).toEqual({
      staticItems: ['c1'],
      dynamicItems: ['S1', 'c2', 'S2'],
    });
  });

  it('stops extending the prefix at a gap even if later items pass', () => {
    // [pass, fail, pass, pass] → prefix is just [pass]
    expect(splitByContiguousPrefix([2, 1, 4, 6], isEven)).toEqual({
      staticItems: [2],
      dynamicItems: [1, 4, 6],
    });
  });

  it('works with objects and a custom predicate', () => {
    type Msg = { id: number; done: boolean };
    const msgs: Msg[] = [
      { id: 1, done: true },
      { id: 2, done: true },
      { id: 3, done: false },
      { id: 4, done: true },
    ];

    const result = splitByContiguousPrefix(msgs, m => m.done);
    expect(result.staticItems).toEqual([
      { id: 1, done: true },
      { id: 2, done: true },
    ]);
    expect(result.dynamicItems).toEqual([
      { id: 3, done: false },
      { id: 4, done: true },
    ]);
  });
});

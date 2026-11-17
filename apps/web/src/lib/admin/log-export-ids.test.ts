import { splitIdList } from './log-export-ids';

describe('splitIdList', () => {
  it.each([
    ['', []],
    ['  ,\n ', []],
    ['a', ['a']],
    ['a,b', ['a', 'b']],
    [' a ,, b\n\tc ', ['a', 'b', 'c']],
    ['a b a', ['a', 'b']],
  ])('splits %j', (value, expected) => {
    expect(splitIdList(value)).toEqual(expected);
  });

  it('combines and deduplicates several values', () => {
    expect(splitIdList('a,b', 'b', 'c d')).toEqual(['a', 'b', 'c', 'd']);
  });
});

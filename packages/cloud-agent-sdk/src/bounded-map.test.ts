import { addBoundedKeeping, setBounded, setBoundedKeeping } from './bounded-map';

describe('setBounded', () => {
  it('evicts the oldest entry once the map grows past the bound', () => {
    const map = new Map<string, number>();
    setBounded(map, 'a', 1, 2);
    setBounded(map, 'b', 2, 2);
    setBounded(map, 'c', 3, 2);
    expect([...map.keys()]).toEqual(['b', 'c']);
  });

  it('keeps a re-set key out of the oldest position', () => {
    const map = new Map<string, number>();
    setBounded(map, 'a', 1, 2);
    setBounded(map, 'b', 2, 2);
    setBounded(map, 'a', 3, 2);
    setBounded(map, 'c', 4, 2);
    expect([...map.keys()]).toEqual(['a', 'c']);
    expect(map.get('a')).toBe(3);
  });
});

describe('setBoundedKeeping', () => {
  it('evicts the oldest entry that is neither the inserted key nor the protected one', () => {
    const map = new Map<string, number>([
      ['active', 0],
      ['old', 1],
      ['new', 2],
    ]);
    setBoundedKeeping(map, 'inserted', 3, 3, 'active');
    expect([...map.keys()]).toEqual(['active', 'new', 'inserted']);
  });

  it('keeps the protected entry when it is the oldest', () => {
    const map = new Map<string, number>([
      ['active', 0],
      ['newer', 1],
    ]);
    setBoundedKeeping(map, 'inserted', 2, 2, 'active');
    expect([...map.keys()]).toEqual(['active', 'inserted']);
    expect(map.get('active')).toBe(0);
  });

  it('drops at most one entry, so the bound is met again on the next insert', () => {
    const map = new Map<string, number>([
      ['active', 0],
      ['a', 1],
      ['b', 2],
      ['c', 3],
    ]);
    setBoundedKeeping(map, 'd', 4, 3, 'active');
    expect(map.size).toBe(4);
    expect([...map.keys()]).toEqual(['active', 'b', 'c', 'd']);
    setBoundedKeeping(map, 'e', 5, 3, 'active');
    expect([...map.keys()]).toEqual(['active', 'c', 'd', 'e']);
  });

  it('never evicts anything while the protected entry and the inserted one are its only entries', () => {
    const map = new Map<string, number>([['active', 0]]);
    setBoundedKeeping(map, 'inserted', 1, 1, 'active');
    expect(map.size).toBe(2);
    setBoundedKeeping(map, 'third', 2, 1, 'active');
    expect([...map.keys()]).toEqual(['active', 'third']);
  });

  it('refreshes the insertion order of a re-set key', () => {
    const map = new Map<string, number>([
      ['a', 1],
      ['b', 2],
    ]);
    setBoundedKeeping(map, 'a', 3, 2, null);
    setBoundedKeeping(map, 'c', 4, 2, null);
    expect([...map.keys()]).toEqual(['a', 'c']);
  });
});

describe('addBoundedKeeping', () => {
  it('adds the key last and evicts the oldest unprotected one', () => {
    const set = new Set<string>(['active', 'old', 'new']);
    addBoundedKeeping(set, 'inserted', 3, 'active');
    expect([...set]).toEqual(['active', 'new', 'inserted']);
  });

  it('keeps a re-added key out of the oldest position', () => {
    const set = new Set<string>(['a', 'b']);
    addBoundedKeeping(set, 'a', 2, null);
    addBoundedKeeping(set, 'c', 2, null);
    expect([...set]).toEqual(['a', 'c']);
  });
});

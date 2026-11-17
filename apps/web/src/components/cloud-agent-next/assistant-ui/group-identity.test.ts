import { reconcileGroupIdentities } from './group-identity';

it('retains group identity through prepends, appends, and removal of its first item', () => {
  const initial = reconcileGroupIdentities([['b', 'c']], []);
  const prepended = reconcileGroupIdentities([['a', 'b', 'c', 'd']], initial);
  expect(prepended).toEqual([{ id: 'b', itemIds: ['a', 'b', 'c', 'd'] }]);
  expect(reconcileGroupIdentities([['c', 'd']], prepended)).toEqual([
    { id: 'b', itemIds: ['c', 'd'] },
  ]);
});

it('retains the group containing the identity when a group splits', () => {
  const previous = [{ id: 'b', itemIds: ['a', 'b', 'c'] }];
  expect(reconcileGroupIdentities([['a'], ['b', 'c']], previous)).toEqual([
    { id: 'a', itemIds: ['a'] },
    { id: 'b', itemIds: ['b', 'c'] },
  ]);
});

it('assigns distinct identities when groups merge and split again', () => {
  const initial = reconcileGroupIdentities([['a'], ['b']], []);
  const merged = reconcileGroupIdentities([['a', 'b']], initial);
  expect(merged).toEqual([{ id: 'a', itemIds: ['a', 'b'] }]);
  expect(reconcileGroupIdentities([['a'], ['b']], merged)).toEqual(initial);
});

it('does not retain identities for unrelated or removed groups', () => {
  expect(reconcileGroupIdentities([['c']], [{ id: 'a', itemIds: ['a', 'b'] }])).toEqual([
    { id: 'c', itemIds: ['c'] },
  ]);
  expect(reconcileGroupIdentities([], [{ id: 'a', itemIds: ['a'] }])).toEqual([]);
});

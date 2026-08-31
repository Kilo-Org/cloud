import { describe, expect, it } from '@jest/globals';
import {
  visibleRepositories,
  withVisibleSelected,
  withoutVisibleSelected,
} from './repository-multi-select-selection';

// `fork: undefined` is a repo cached before the flag existed — it must stay listed.
const repositories = [
  { id: 1, fork: false },
  { id: 2, fork: true },
  { id: 3, fork: undefined },
];

describe('visibleRepositories', () => {
  it('lists every repository when forks are not hidden', () => {
    expect(visibleRepositories(repositories, false).map(repo => repo.id)).toEqual([1, 2, 3]);
  });

  it('drops only forks when forks are hidden', () => {
    expect(visibleRepositories(repositories, true).map(repo => repo.id)).toEqual([1, 3]);
  });
});

describe('withVisibleSelected', () => {
  it('adds the visible repositories without duplicating a selected one', () => {
    expect(withVisibleSelected([1, 5], [1, 3])).toEqual([1, 5, 3]);
  });
});

describe('withoutVisibleSelected', () => {
  it('clears the visible repositories and keeps a hidden selection', () => {
    expect(withoutVisibleSelected([1, 2, 3], [1, 3])).toEqual([2]);
  });
});

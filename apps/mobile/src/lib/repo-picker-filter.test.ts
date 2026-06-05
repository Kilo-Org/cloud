import { describe, expect, it } from 'vitest';

import { filterRepoPickerOptions } from './repo-picker-filter';

const repositories = [
  { fullName: 'Kilo-Org/cloud', isPrivate: true },
  { fullName: 'octocat/Hello-World', isPrivate: false },
];

describe('filterRepoPickerOptions', () => {
  it('returns all repositories when search is empty', () => {
    expect(filterRepoPickerOptions({ repositories, search: '' })).toEqual(repositories);
  });

  it('filters repositories by full name case-insensitively', () => {
    expect(filterRepoPickerOptions({ repositories, search: 'hello' })).toEqual([repositories[1]]);
  });
});

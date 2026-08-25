import { describe, expect, it } from 'vitest';

import { type RepoOption } from './picker-bridge';
import { filterRepoPickerOptions } from './repo-picker-filter';

const repositories: RepoOption[] = [
  { fullName: 'Kilo-Org/cloud', isPrivate: true, platform: 'github' },
  { fullName: 'octocat/Hello-World', isPrivate: false, platform: 'github' },
  { fullName: 'acme/widgets', isPrivate: true, platform: 'github' },
];

describe('filterRepoPickerOptions', () => {
  it('returns all repositories in backend order when search is empty', () => {
    expect(filterRepoPickerOptions({ repositories, search: '' })).toEqual(repositories);
  });

  it('filters repositories by full name case-insensitively', () => {
    expect(filterRepoPickerOptions({ repositories, search: 'hello' })).toEqual([repositories[1]]);
  });
});

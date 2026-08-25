import { describe, expect, it } from 'vitest';

import { filterRepoPickerOptions, groupRepoPickerOptions } from './repo-picker-filter';

const repositories = [
  {
    key: 'integration-1:Kilo-Org/cloud',
    fullName: 'Kilo-Org/cloud',
    isPrivate: true,
    platformIntegrationId: 'integration-1',
    platformAccountLogin: 'Kilo-Org',
  },
  { key: 'octocat/Hello-World', fullName: 'octocat/Hello-World', isPrivate: false },
  { key: 'acme/widgets', fullName: 'acme/widgets', isPrivate: true },
];

describe('filterRepoPickerOptions', () => {
  it('returns all repositories in backend order when search is empty', () => {
    expect(filterRepoPickerOptions({ repositories, search: '' })).toEqual(repositories);
  });

  it('filters repositories by full name case-insensitively', () => {
    expect(filterRepoPickerOptions({ repositories, search: 'hello' })).toEqual([repositories[1]]);
  });

  it('filters and groups repositories by GitHub account while retaining legacy entries', () => {
    expect(filterRepoPickerOptions({ repositories, search: 'kilo-org' })).toEqual([
      repositories[0],
    ]);
    expect(groupRepoPickerOptions(repositories)).toEqual([
      { title: 'Kilo-Org', data: [repositories[0]] },
      { title: undefined, data: [repositories[1], repositories[2]] },
    ]);
  });
});

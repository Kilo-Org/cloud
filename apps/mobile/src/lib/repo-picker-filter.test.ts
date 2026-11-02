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
    expect(filterRepoPickerOptions({ repositories, search: '   ' })).toEqual(repositories);
  });

  it('filters repositories by full name case-insensitively', () => {
    expect(filterRepoPickerOptions({ repositories, search: 'hello' })).toEqual([repositories[1]]);
    expect(filterRepoPickerOptions({ repositories, search: 'KILO-ORG/CLOUD' })).toEqual([
      repositories[0],
    ]);
  });

  it('matches the owner half of the full name too', () => {
    expect(
      filterRepoPickerOptions({ repositories, search: 'acme' }).map(repo => repo.fullName)
    ).toEqual(['acme/widgets']);
  });

  it('ignores whitespace around a typed query', () => {
    expect(
      filterRepoPickerOptions({ repositories, search: '  widgets  ' }).map(repo => repo.fullName)
    ).toEqual(['acme/widgets']);
  });

  it('keeps the caller order of the rows that match', () => {
    const rows = [
      { id: 'b', fullName: 'acme/cloud-tools' },
      { id: 'a', fullName: 'Kilo-Org/cloud' },
    ];
    expect(filterRepoPickerOptions({ repositories: rows, search: 'cloud' })).toEqual(rows);
  });

  it('matches nothing when no full name contains the query', () => {
    expect(filterRepoPickerOptions({ repositories, search: 'missing' })).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { type RepoOption } from './picker-bridge';
import { filterRepoPickerOptions, groupRepoPickerOptions } from './repo-picker-filter';

const repositories: RepoOption[] = [
  {
    fullName: 'Kilo-Org/cloud',
    isPrivate: true,
    platform: 'github',
    platformIntegrationId: 'integration-1',
    platformAccountLogin: 'Kilo-Org',
  },
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

  it('filters repositories by GitHub account case-insensitively', () => {
    expect(filterRepoPickerOptions({ repositories, search: 'kilo-org' })).toEqual([
      repositories[0],
    ]);
  });
});

describe('groupRepoPickerOptions', () => {
  it('groups GitHub repositories by account and retains provenance-free rows', () => {
    expect(groupRepoPickerOptions(repositories)).toEqual([
      { key: 'github:Kilo-Org', title: 'Kilo-Org', repos: [repositories[0]] },
      {
        key: 'github',
        titleKey: 'agentChat.repoPicker.platformGithub',
        repos: [repositories[1], repositories[2]],
      },
    ]);
  });

  it('keeps duplicate full names from separate integrations as separate rows', () => {
    const firstRepository = repositories[0];
    if (!firstRepository) {
      throw new Error('Expected GitHub repository fixture');
    }
    const duplicate = {
      ...firstRepository,
      platformIntegrationId: 'integration-2',
      platformAccountLogin: 'Second Account',
    };

    const sections = groupRepoPickerOptions([firstRepository, duplicate]);
    expect(sections.flatMap(section => section.repos)).toEqual([firstRepository, duplicate]);
  });
});

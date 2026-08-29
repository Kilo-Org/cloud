import { describe, expect, it } from 'vitest';

import {
  type NewSessionRepository,
  normalizeSessionRepository,
  repositoryKey,
  type ResolvedNewSessionRepository,
} from '@/components/agents/new-session-repository-state';
import { filterRepoPickerOptions } from './repo-picker-filter';

const repositories: NewSessionRepository[] = [
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

  it.each(['git.example.com/base', 'integration-2', 'org:team-2'])(
    'finds a same-named repository by its exact identity label %s',
    search => {
      const qualified: NewSessionRepository = {
        platform: 'gitlab',
        fullName: 'Kilo-Org/cloud',
        isPrivate: true,
        reference: {
          repository: {
            provider: 'gitlab',
            instanceUrl: 'https://git.example.com/base',
            repositoryId: '7',
            fullName: 'Kilo-Org/cloud',
            defaultBranch: null,
          },
          authorization: {
            kind: 'ownerIntegration',
            owner: { type: 'org', id: 'team-2' },
            integrationId: 'integration-2',
          },
        },
      };
      expect(
        filterRepoPickerOptions({ repositories: [...repositories, qualified], search })
      ).toEqual([qualified]);
    }
  );

  it('keeps normalized identity when filtering same-named integrations for selection', () => {
    const rows = ['integration-1', 'integration-2'].flatMap(integrationId => {
      const row = normalizeSessionRepository(
        {
          private: true,
          repositoryReference: {
            repository: {
              provider: 'gitlab',
              instanceUrl: 'https://git.example.com/base',
              repositoryId: '7',
              fullName: 'Kilo-Org/cloud',
              defaultBranch: 'develop',
            },
            authorization: {
              kind: 'ownerIntegration',
              owner: { type: 'org', id: 'team-2' },
              integrationId,
            },
          },
        },
        'user-1',
        'team-2'
      );
      return row ? [row] : [];
    });
    const filtered: ResolvedNewSessionRepository[] = filterRepoPickerOptions({
      repositories: rows,
      search: 'integration-2',
    });
    expect(filtered).toEqual([rows[1]]);
    expect(filtered.map(row => repositoryKey(row))).toEqual([rows[1]?.key]);
  });
});

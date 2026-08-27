import {
  findSelectedRepository,
  groupGitHubRepositories,
  repositorySelection,
} from './github-repository-selection';
import type { RepositoryOption } from '@/components/shared/RepositoryCombobox';

const repositories: RepositoryOption[] = [
  {
    id: 1,
    fullName: 'acme/api',
    platform: 'github',
    platformIntegrationId: '11111111-1111-4111-8111-111111111111',
    platformAccountLogin: 'acme',
  },
  {
    id: 1,
    fullName: 'acme/api',
    platform: 'github',
    platformIntegrationId: '22222222-2222-4222-8222-222222222222',
    platformAccountLogin: 'acme',
  },
  {
    id: 2,
    fullName: 'octo/docs',
    platform: 'github',
    platformIntegrationId: '33333333-3333-4333-8333-333333333333',
    platformAccountLogin: 'octo',
  },
];

describe('GitHub repository selection', () => {
  it('groups by installation account and distinguishes duplicate account installations', () => {
    expect(groupGitHubRepositories(repositories).map(group => group.label)).toEqual([
      'acme (11111111)',
      'acme (22222222)',
      'octo',
    ]);
  });

  it('keeps repository, integration ID, and account together in selection state', () => {
    expect(repositorySelection(repositories[0])).toEqual({
      repository: 'acme/api',
      platformIntegrationId: '11111111-1111-4111-8111-111111111111',
      platformAccountLogin: 'acme',
    });
  });

  it('does not switch an unavailable pin to another installation with the same repository', () => {
    expect(
      findSelectedRepository(repositories, {
        repository: 'acme/api',
        platformIntegrationId: '44444444-4444-4444-8444-444444444444',
      })
    ).toBeUndefined();
  });

  it('does not guess when a legacy unpinned repository is duplicated', () => {
    expect(findSelectedRepository(repositories, { repository: 'acme/api' })).toBeUndefined();
    expect(findSelectedRepository(repositories, { repository: 'octo/docs' })).toBeUndefined();
  });
});

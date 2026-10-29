import { describe, expect, it } from '@jest/globals';
import {
  addRepository,
  entryToRepository,
  removeRepository,
  repositoryKey,
  sameRepositories,
} from './environment-repositories';

const web = { platform: 'github', fullName: 'Acme/Web' } as const;
const api = { platform: 'github', fullName: 'acme/api' } as const;
const bitbucket = {
  platform: 'bitbucket',
  fullName: 'team/old-name',
  workspaceUuid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  repositoryUuid: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
} as const;

describe('environment repository list', () => {
  it('identifies a repository without case, and a Bitbucket one by its UUID pair', () => {
    expect(repositoryKey(web)).toBe(repositoryKey({ platform: 'github', fullName: 'acme/web' }));
    expect(repositoryKey(web)).not.toBe(
      repositoryKey({ platform: 'gitlab', projectPath: 'acme/web' })
    );
    expect(repositoryKey(bitbucket)).toBe(
      repositoryKey({ ...bitbucket, fullName: 'team/new-name' })
    );
  });

  it('adds a repository once and keeps the order', () => {
    const list = addRepository(addRepository([web], api), { ...web, fullName: 'acme/WEB' });
    expect(list).toEqual([web, api]);
  });

  it('removes a repository by identity', () => {
    expect(removeRepository([web, api], { platform: 'github', fullName: 'ACME/web' })).toEqual([
      api,
    ]);
  });

  it('compares two lists by identity and order', () => {
    expect(sameRepositories([web, api], [{ ...web, fullName: 'acme/web' }, api])).toBe(true);
    expect(sameRepositories([web, api], [api, web])).toBe(false);
    expect(sameRepositories([web], [web, api])).toBe(false);
  });

  it('turns a stored entry into the input shape of each platform', () => {
    expect(entryToRepository({ platform: 'github', repoFullName: 'acme/web' })).toEqual({
      platform: 'github',
      fullName: 'acme/web',
    });
    expect(
      entryToRepository({
        platform: 'gitlab',
        repoFullName: 'group/project',
        gitlabCloneUrl: 'https://gitlab.com/group/project.git',
      })
    ).toEqual({ platform: 'gitlab', projectPath: 'group/project' });
    expect(
      entryToRepository({
        platform: 'bitbucket',
        repoFullName: 'team/repo',
        bitbucketWorkspaceUuid: 'w',
        bitbucketRepositoryUuid: 'r',
      })
    ).toEqual({
      platform: 'bitbucket',
      fullName: 'team/repo',
      workspaceUuid: 'w',
      repositoryUuid: 'r',
    });
  });
});

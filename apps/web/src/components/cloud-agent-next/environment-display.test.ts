import { describe, expect, it } from '@jest/globals';
import type { EnvironmentSummary } from '@kilocode/cloud-agent-profile';
import { findRepositoryEnvironment } from './environment-display';

function summary(partial: Partial<EnvironmentSummary>): EnvironmentSummary {
  return {
    id: 'environment',
    name: 'Environment',
    platform: 'github',
    repoFullName: 'acme/widgets',
    gitlabCloneUrl: null,
    bitbucketWorkspaceUuid: null,
    bitbucketRepositoryUuid: null,
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    plainVarCount: 0,
    secretCount: 0,
    commandCount: 0,
    sandboxAllocation: null,
    ...partial,
  };
}

describe('findRepositoryEnvironment', () => {
  const github = summary({ id: 'github' });
  const gitlab = summary({
    id: 'gitlab',
    platform: 'gitlab',
    repoFullName: 'group/project',
    gitlabCloneUrl: 'https://gitlab.com/group/project.git',
  });
  const bitbucket = summary({
    id: 'bitbucket',
    platform: 'bitbucket',
    repoFullName: 'team/old-name',
    bitbucketWorkspaceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    bitbucketRepositoryUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  });
  const environments = [github, gitlab, bitbucket];

  it('matches GitHub and GitLab paths without case and never across platforms', () => {
    expect(
      findRepositoryEnvironment(environments, { platform: 'github', fullName: 'Acme/Widgets' })
    ).toBe(github);
    expect(
      findRepositoryEnvironment(environments, { platform: 'gitlab', projectPath: 'Group/Project' })
    ).toBe(gitlab);
    expect(
      findRepositoryEnvironment(environments, { platform: 'gitlab', projectPath: 'acme/widgets' })
    ).toBeUndefined();
  });

  it('matches Bitbucket by the UUID pair after a rename', () => {
    expect(
      findRepositoryEnvironment(environments, {
        platform: 'bitbucket',
        fullName: 'team/new-name',
        workspaceUuid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        repositoryUuid: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      })
    ).toBe(bitbucket);
    expect(
      findRepositoryEnvironment(environments, {
        platform: 'bitbucket',
        fullName: 'team/old-name',
        workspaceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        repositoryUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      })
    ).toBeUndefined();
  });
});

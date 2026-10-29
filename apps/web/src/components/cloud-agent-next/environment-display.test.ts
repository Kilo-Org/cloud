import { describe, expect, it } from '@jest/globals';
import type { EnvironmentSummary } from '@kilocode/cloud-agent-profile';
import { findRepositoryEnvironments } from './environment-display';

/** A V1 summary: one repository in the identity scalars. */
type V1Summary = Extract<EnvironmentSummary, { platform: string }>;

function summary(partial: Partial<V1Summary>): EnvironmentSummary {
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
    configurationRevision: 1,
    ...partial,
  };
}

describe('findRepositoryEnvironments', () => {
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
      findRepositoryEnvironments(environments, { platform: 'github', fullName: 'Acme/Widgets' })
    ).toEqual([github]);
    expect(
      findRepositoryEnvironments(environments, { platform: 'gitlab', projectPath: 'Group/Project' })
    ).toEqual([gitlab]);
    expect(
      findRepositoryEnvironments(environments, { platform: 'gitlab', projectPath: 'acme/widgets' })
    ).toEqual([]);
  });

  it('matches Bitbucket by the UUID pair after a rename', () => {
    expect(
      findRepositoryEnvironments(environments, {
        platform: 'bitbucket',
        fullName: 'team/new-name',
        workspaceUuid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        repositoryUuid: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      })
    ).toEqual([bitbucket]);
    expect(
      findRepositoryEnvironments(environments, {
        platform: 'bitbucket',
        fullName: 'team/old-name',
        workspaceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        repositoryUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      })
    ).toEqual([]);
  });
});

describe('findRepositoryEnvironments with multi-repository environments', () => {
  const v1 = summary({ id: 'v1' });
  const v2: EnvironmentSummary = {
    id: 'v2',
    name: 'Group',
    repositories: [
      { platform: 'github', repoFullName: 'acme/api' },
      { platform: 'github', repoFullName: 'acme/widgets' },
    ],
    createdAt: '2026-10-21T00:00:00.000Z',
    updatedAt: '2026-10-21T00:00:00.000Z',
    plainVarCount: 0,
    secretCount: 0,
    commandCount: 0,
    sandboxAllocation: null,
    configurationRevision: 1,
  };

  it('returns every environment that contains the repository, V1 and V2', () => {
    expect(
      findRepositoryEnvironments([v1, v2], { platform: 'github', fullName: 'acme/widgets' })
    ).toEqual([v1, v2]);
    expect(
      findRepositoryEnvironments([v1, v2], { platform: 'github', fullName: 'Acme/API' })
    ).toEqual([v2]);
  });
});

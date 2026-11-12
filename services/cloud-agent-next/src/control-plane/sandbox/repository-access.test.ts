import { describe, expect, it, vi } from 'vitest';
import {
  workspaceRepositoryAccessSchema,
  githubPermissionsAreRestricted,
  githubRepositoryPermissions,
  MAX_WORKSPACE_REPOSITORIES,
} from '@kilocode/worker-utils/workspace-repository-access';
import type { SessionCredentialGrant } from '../../sandbox-control/session-credentials.js';
import type { GitTokenService } from '../../types.js';
import {
  repositoryAccessFromTrustedGrant,
  repositoryAccessFromAdmittedSource,
} from './repository-access-initialization.js';

const repository = {
  repositoryId: 101,
  nodeId: 'R_101',
  owner: 'acme',
  name: 'repo',
  mode: 'contribute' as const,
  source: 'environment' as const,
  approvedBy: 'oauth/owner',
  approvedAt: 1,
  integrationId: '00000000-0000-4000-8000-000000000001',
  identity: {
    source: 'installation' as const,
    providerSubjectId: '123',
    appType: 'standard' as const,
  },
};
const policy = {
  version: 1,
  scopeId: 'worktree_existing',
  revision: 0,
  repositories: [repository],
};
describe('repository access contracts and legacy initialization', () => {
  it('rejects duplicates, unknown versions and corrupt modes while preserving large legacy policies', () => {
    expect(workspaceRepositoryAccessSchema.safeParse(policy).success).toBe(true);
    expect(
      workspaceRepositoryAccessSchema.safeParse({
        ...policy,
        repositories: Array.from({ length: MAX_WORKSPACE_REPOSITORIES + 1 }, (_, index) => ({
          ...repository,
          repositoryId: index + 1,
        })),
      }).success
    ).toBe(true);
    for (const value of [
      { ...policy, version: 2 },
      { ...policy, repositories: [repository, repository] },
      { ...policy, repositories: [{ ...repository, mode: 'admin' }] },
    ])
      expect(workspaceRepositoryAccessSchema.safeParse(value).success).toBe(false);
  });
  it('never accepts broader or unknown provider permissions', () => {
    expect(githubPermissionsAreRestricted(githubRepositoryPermissions('read'), 'read')).toBe(true);
    expect(githubPermissionsAreRestricted(githubRepositoryPermissions('contribute'), 'read')).toBe(
      false
    );
    expect(
      githubPermissionsAreRestricted(
        { ...githubRepositoryPermissions('contribute'), workflows: 'write' },
        'contribute'
      )
    ).toBe(false);
    expect(
      githubPermissionsAreRestricted(
        { ...githubRepositoryPermissions('contribute'), administration: 'read' },
        'contribute'
      )
    ).toBe(false);
    expect(githubPermissionsAreRestricted({}, 'read')).toBe(false);
  });
  it('passes the persisted signed identity to server initialization and preserves the source object', async () => {
    const grant = {
      scopeId: 'worktree_existing',
      userId: 'oauth/owner',
      repository: { type: 'github', repo: 'acme/repo' },
      scm: {
        purpose: 'github',
        alias: 'stable-alias',
        githubAuthSource: 'installation',
        capability: { credential: 'kgh2.persisted' },
      },
    } as SessionCredentialGrant;
    const before = structuredClone(grant);
    const prepare = vi.fn(async () => ({ success: true, repository }));
    const result = await repositoryAccessFromTrustedGrant(grant, {
      prepareWorkspaceRepositoryAccess: prepare,
    } as unknown as GitTokenService);
    expect(result).toEqual(policy);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        persistedCapability: 'kgh2.persisted',
        expectedSource: 'installation',
        userId: 'oauth/owner',
        githubRepo: 'acme/repo',
      })
    );
    expect(grant).toEqual(before);
  });
  it('initializes more than 64 configured repositories with at most four provider calls in flight', async () => {
    const grant = {
      scopeId: 'worktree_existing',
      userId: 'oauth/owner',
      repository: { type: 'github', repo: 'acme/repo-1' },
      scm: { purpose: 'github' },
      additionalRepositories: Array.from({ length: 69 }, (_, index) => ({
        repository: { type: 'github', repo: `acme/repo-${index + 2}` },
        scm: { purpose: 'github' },
      })),
    } as SessionCredentialGrant;
    let active = 0,
      maximum = 0;
    const tokens = {
      prepareWorkspaceRepositoryAccess: async (input: { githubRepo: string }) => {
        active++;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active--;
        return {
          success: true,
          repository: {
            ...repository,
            repositoryId: Number(input.githubRepo.split('-').at(-1)),
            name: input.githubRepo.split('/')[1],
          },
        };
      },
    } as unknown as GitTokenService;
    expect((await repositoryAccessFromTrustedGrant(grant, tokens)).repositories).toHaveLength(70);
    expect(maximum).toBeLessThanOrEqual(4);
  });

  it('preserves an admitted installation-only launch identity during initial policy creation', async () => {
    const prepare = vi.fn(async () => ({ success: true, repository }));
    await repositoryAccessFromAdmittedSource(
      {
        userId: 'oauth/owner',
        kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
        kiloToken: 'synthetic',
        createdOnPlatform: 'cloud-agent-web',
        repository: { type: 'github', repo: 'acme/repo', allowUserAuthorization: false },
        scopeId: 'worktree_existing',
      },
      null,
      { prepareWorkspaceRepositoryAccess: prepare } as unknown as GitTokenService,
      'worktree_existing'
    );
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSource: 'installation' })
    );
  });

  it.each([
    ['cloud-agent-web', undefined, undefined],
    ['slack', undefined, undefined],
    ['agent-manager', undefined, undefined],
    ['automation', undefined, 'installation'],
    ['cloud-agent-web', false, 'installation'],
    ['automation', true, undefined],
  ] as const)(
    'preserves identity selection for %s with flag %s',
    async (createdOnPlatform, allowUserAuthorization, expectedSource) => {
      const prepare = vi.fn(async () => ({ success: true, repository }));
      await repositoryAccessFromAdmittedSource(
        {
          userId: 'oauth/owner',
          kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
          kiloToken: 'synthetic',
          createdOnPlatform,
          repository: { type: 'github', repo: 'acme/repo', allowUserAuthorization },
          scopeId: 'worktree_existing',
        },
        null,
        { prepareWorkspaceRepositoryAccess: prepare } as unknown as GitTokenService,
        'worktree_existing'
      );
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({ expectedSource, accessPurpose: 'workflow' })
      );
    }
  );
  it('initializes an additional GitHub member when the launch repository uses GitLab', async () => {
    const prepare = vi.fn(async () => ({ success: true, repository }));
    const environment = {
      environmentId: '00000000-0000-4000-8000-000000000001',
      owner: { type: 'user' as const, id: 'oauth/owner' },
      configurationRevision: 1,
      repositories: [
        {
          identity: { platform: 'github' as const, repoFullName: 'acme/repo' },
          repoFullName: 'acme/repo',
          leaf: 'repo',
          branch: 'main',
        },
      ],
    };
    expect(
      (
        await repositoryAccessFromAdmittedSource(
          {
            userId: 'oauth/owner',
            kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
            kiloToken: 'synthetic',
            createdOnPlatform: 'cloud-agent-web',
            repository: { type: 'gitlab', url: 'https://gitlab.com/acme/launch.git' },
            scopeId: 'worktree_existing',
          },
          environment,
          { prepareWorkspaceRepositoryAccess: prepare } as unknown as GitTokenService,
          'worktree_existing'
        )
      ).repositories
    ).toHaveLength(1);
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        githubRepo: 'acme/repo',
        expectedSource: undefined,
        accessPurpose: 'workflow',
      })
    );
  });

  it('does not initialize partial authority after a provider failure', async () => {
    const grant = {
      scopeId: 'worktree_existing',
      userId: 'oauth/owner',
      repository: { type: 'github', repo: 'acme/repo' },
      scm: { purpose: 'github' },
    } as SessionCredentialGrant;
    await expect(
      repositoryAccessFromTrustedGrant(grant, {
        prepareWorkspaceRepositoryAccess: async () => ({
          success: false,
          reason: 'authorization_unavailable',
        }),
      } as unknown as GitTokenService)
    ).rejects.toThrow('Repository authorization unavailable');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { assertRepositoryAccessBeforeSessionCreation } from './validate-repository-access.js';

const repository = {
  type: 'bitbucket' as const,
  url: 'https://bitbucket.org/acme/repo.git',
  workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
  repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
};

describe('GitHub session creation preflight', () => {
  it('skips legacy GitHub repositories without an integration pin', async () => {
    const getTokenForRepo = vi.fn();

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getTokenForRepo } } as never,
        userId: 'user-1',
        repository: { type: 'github', repo: 'acme/repo' },
      })
    ).resolves.toBeUndefined();
    expect(getTokenForRepo).not.toHaveBeenCalled();
  });

  it('preflights a pinned GitHub repository against the exact integration', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: true,
      token: 'token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
    });
    const orgId = '123e4567-e89b-12d3-a456-426614174030';
    const expectedIntegrationId = '123e4567-e89b-12d3-a456-426614174022';

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getTokenForRepo } } as never,
        userId: 'user-1',
        orgId,
        repository: {
          type: 'github',
          repo: 'acme/repo',
          githubIntegrationId: expectedIntegrationId,
        },
      })
    ).resolves.toBeUndefined();
    expect(getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user-1',
      orgId,
      expectedIntegrationId,
    });
  });

  it('rejects an integration mismatch before session allocation', async () => {
    const getTokenForRepo = vi.fn().mockResolvedValue({
      success: false,
      reason: 'integration_mismatch',
    });

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getTokenForRepo } } as never,
        userId: 'user-1',
        repository: {
          type: 'github',
          repo: 'acme/repo',
          githubIntegrationId: '123e4567-e89b-12d3-a456-426614174022',
        },
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'GitHub repository authorization failed (integration_mismatch)',
    });
  });
});

describe('Bitbucket session creation preflight', () => {
  it('validates organization sessions against the organization-owned integration', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({ success: true, token: 'token' });
    const orgId = '123e4567-e89b-12d3-a456-426614174030';

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        orgId,
        repository,
      })
    ).resolves.toBeUndefined();
    expect(getBitbucketToken).toHaveBeenCalledWith({
      userId: 'user-1',
      orgId,
      workspaceUuid: repository.workspaceUuid,
      repositoryUuid: repository.repositoryUuid,
      repositoryUrl: repository.url,
    });
  });

  it('forwards an expected integration id when the repository carries one', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({ success: true, token: 'token' });
    const orgId = '123e4567-e89b-12d3-a456-426614174030';
    const integrationId = '123e4567-e89b-12d3-a456-426614174022';

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        orgId,
        repository: { ...repository, bitbucketIntegrationId: integrationId },
      })
    ).resolves.toBeUndefined();
    expect(getBitbucketToken).toHaveBeenCalledWith({
      userId: 'user-1',
      orgId,
      expectedIntegrationId: integrationId,
      workspaceUuid: repository.workspaceUuid,
      repositoryUuid: repository.repositoryUuid,
      repositoryUrl: repository.url,
    });
  });

  it('rejects personal Bitbucket sessions before invoking the service binding', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({ success: true, token: 'token' });

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        repository,
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Bitbucket repositories require an organization',
    });
    expect(getBitbucketToken).not.toHaveBeenCalled();
  });

  it('keeps insufficient workspace permissions distinguishable', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({
      success: false,
      reason: 'insufficient_permissions',
    });

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        orgId: '123e4567-e89b-12d3-a456-426614174030',
        repository,
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Bitbucket repository authorization failed (insufficient_permissions)',
    });
  });

  it('reports temporary provider failures as service unavailable', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({
      success: false,
      reason: 'temporarily_unavailable',
    });

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        orgId: '123e4567-e89b-12d3-a456-426614174030',
        repository,
      })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Bitbucket repository authorization failed (temporarily_unavailable)',
    });
  });

  it('reports an unavailable token-service binding as service unavailable', async () => {
    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: {} as never,
        userId: 'user-1',
        orgId: '123e4567-e89b-12d3-a456-426614174030',
        repository,
      })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Bitbucket repository authorization failed (service_not_configured)',
    });
  });

  it('reports token-service RPC failures as service unavailable', async () => {
    const getBitbucketToken = vi.fn().mockRejectedValue(new Error('binding unavailable'));

    await expect(
      assertRepositoryAccessBeforeSessionCreation({
        env: { GIT_TOKEN_SERVICE: { getBitbucketToken } } as never,
        userId: 'user-1',
        orgId: '123e4567-e89b-12d3-a456-426614174030',
        repository,
      })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Bitbucket repository authorization failed (rpc_error)',
    });
  });
});

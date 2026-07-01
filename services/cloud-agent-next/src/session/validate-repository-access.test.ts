import { describe, expect, it, vi } from 'vitest';
import { assertBitbucketRepositoryAccessBeforeSessionCreation } from './validate-repository-access.js';

const repository = {
  type: 'bitbucket' as const,
  url: 'https://bitbucket.org/acme/repo.git',
  workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
  repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
};

describe('Bitbucket session creation preflight', () => {
  it('validates organization sessions against the organization-owned integration', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({ success: true, token: 'token' });
    const orgId = '123e4567-e89b-12d3-a456-426614174030';

    await expect(
      assertBitbucketRepositoryAccessBeforeSessionCreation({
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

  it('rejects personal Bitbucket sessions before invoking the service binding', async () => {
    const getBitbucketToken = vi.fn().mockResolvedValue({ success: true, token: 'token' });

    await expect(
      assertBitbucketRepositoryAccessBeforeSessionCreation({
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
      assertBitbucketRepositoryAccessBeforeSessionCreation({
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
      assertBitbucketRepositoryAccessBeforeSessionCreation({
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
      assertBitbucketRepositoryAccessBeforeSessionCreation({
        env: {} as never,
        userId: 'user-1',
        orgId: '123e4567-e89b-12d3-a456-426614174030',
        repository,
      })
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Bitbucket repository authorization failed (temporarily_unavailable)',
    });
  });

  it('reports token-service RPC failures as service unavailable', async () => {
    const getBitbucketToken = vi.fn().mockRejectedValue(new Error('binding unavailable'));

    await expect(
      assertBitbucketRepositoryAccessBeforeSessionCreation({
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
});

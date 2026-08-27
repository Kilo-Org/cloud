import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMigrateToGithub } from './migrate-to-github';
import type { Env, GetTokenForRepoResult } from '../types';

const expectedPlatformIntegrationId = '123e4567-e89b-12d3-a456-426614174002';
const resolvedPlatformIntegrationId = '123e4567-e89b-12d3-a456-426614174003';
const orgId = '123e4567-e89b-12d3-a456-426614174001';

function createEnv(tokenResult: GetTokenForRepoResult) {
  const getTokenForRepo = vi.fn().mockResolvedValue(tokenResult);
  const gitStub = {
    isInitialized: vi.fn().mockResolvedValue(true),
    pushToRemote: vi.fn().mockResolvedValue({ success: true }),
    scheduleDelete: vi.fn().mockResolvedValue(undefined),
  };
  const previewStub = { setGitHubSource: vi.fn().mockResolvedValue(undefined) };
  return {
    env: {
      AUTH_TOKEN: 'worker-auth',
      GIT_TOKEN_SERVICE: { getTokenForRepo },
      GIT_REPOSITORY: {
        idFromName: vi.fn(() => 'git-id'),
        get: vi.fn(() => gitStub),
      },
      PREVIEW: {
        idFromName: vi.fn(() => 'preview-id'),
        get: vi.fn(() => previewStub),
      },
    } as unknown as Env,
    getTokenForRepo,
    gitStub,
    previewStub,
  };
}

function request(expectedId?: string) {
  return new Request('https://builder.example.com/apps/app-1/migrate-to-github', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer worker-auth',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      githubRepo: 'acme/secondary',
      userId: 'oauth/example-user',
      orgId,
      expectedPlatformIntegrationId: expectedId,
    }),
  });
}

const successfulToken: GetTokenForRepoResult = {
  success: true,
  token: 'github-token',
  platformIntegrationId: resolvedPlatformIntegrationId,
  installationId: 'installation-1',
  accountLogin: 'acme',
  appType: 'standard',
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 409 })));
});

describe('migrate-to-github integration identity', () => {
  it('persists and returns the integration resolved by Git Token Service', async () => {
    const harness = createEnv(successfulToken);

    const response = await handleMigrateToGithub(request(), harness.env, 'app-1');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      platformIntegrationId: resolvedPlatformIntegrationId,
    });
    expect(harness.getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/secondary',
      userId: 'oauth/example-user',
      orgId,
      expectedIntegrationId: undefined,
    });
    expect(harness.previewStub.setGitHubSource).toHaveBeenCalledWith({
      githubRepo: 'acme/secondary',
      userId: 'oauth/example-user',
      orgId,
      platformIntegrationId: resolvedPlatformIntegrationId,
    });
  });

  it('preserves token resolution failures without mutating Git or preview state', async () => {
    const harness = createEnv({ success: false, reason: 'temporarily_unavailable' });

    const response = await handleMigrateToGithub(request(), harness.env, 'app-1');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'token_failed',
      message: 'Failed to get GitHub token: temporarily_unavailable',
    });
    expect(harness.gitStub.pushToRemote).not.toHaveBeenCalled();
    expect(harness.previewStub.setGitHubSource).not.toHaveBeenCalled();
  });

  it('uses an exact selected integration only as a resolution fence', async () => {
    const harness = createEnv({ success: false, reason: 'integration_mismatch' });

    const response = await handleMigrateToGithub(
      request(expectedPlatformIntegrationId),
      harness.env,
      'app-1'
    );

    expect(response.status).toBe(500);
    expect(harness.getTokenForRepo).toHaveBeenCalledWith(
      expect.objectContaining({ expectedIntegrationId: expectedPlatformIntegrationId })
    );
    expect(harness.gitStub.pushToRemote).not.toHaveBeenCalled();
    expect(harness.previewStub.setGitHubSource).not.toHaveBeenCalled();
  });

  it('preserves the non-empty repository failure before pushing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([{ sha: 'existing-commit' }]));
    const harness = createEnv(successfulToken);

    const response = await handleMigrateToGithub(request(), harness.env, 'app-1');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'repo_not_empty',
    });
    expect(harness.gitStub.pushToRemote).not.toHaveBeenCalled();
    expect(harness.previewStub.setGitHubSource).not.toHaveBeenCalled();
  });
});

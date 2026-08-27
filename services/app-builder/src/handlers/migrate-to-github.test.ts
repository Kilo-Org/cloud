import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMigrateToGithub } from './migrate-to-github';
import type { Env } from '../types';

const expectedPlatformIntegrationId = '123e4567-e89b-12d3-a456-426614174002';
const orgId = '123e4567-e89b-12d3-a456-426614174001';

function createEnv(
  tokenResult: { success: false; reason: 'integration_mismatch' } | { success: true }
) {
  const getTokenForRepo = vi.fn().mockResolvedValue(
    tokenResult.success
      ? {
          success: true,
          token: 'github-token',
          installationId: 'installation-1',
          accountLogin: 'acme',
          appType: 'standard',
        }
      : tokenResult
  );
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

function request() {
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
      expectedPlatformIntegrationId,
    }),
  });
}

beforeEach(() => vi.clearAllMocks());

describe('migrate-to-github integration identity', () => {
  it('fences the initial push and persisted preview source to the expected integration', async () => {
    const harness = createEnv({ success: true });

    const response = await handleMigrateToGithub(request(), harness.env, 'app-1');

    expect(response.status).toBe(200);
    expect(harness.getTokenForRepo).toHaveBeenCalledWith({
      githubRepo: 'acme/secondary',
      userId: 'oauth/example-user',
      orgId,
      expectedIntegrationId: expectedPlatformIntegrationId,
    });
    expect(harness.previewStub.setGitHubSource).toHaveBeenCalledWith({
      githubRepo: 'acme/secondary',
      userId: 'oauth/example-user',
      orgId,
      expectedPlatformIntegrationId,
    });
  });

  it('fails a stale integration before pushing or changing preview source', async () => {
    const harness = createEnv({ success: false, reason: 'integration_mismatch' });

    const response = await handleMigrateToGithub(request(), harness.env, 'app-1');

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'token_failed',
      message: 'Failed to get GitHub token: integration_mismatch',
    });
    expect(harness.gitStub.pushToRemote).not.toHaveBeenCalled();
    expect(harness.previewStub.setGitHubSource).not.toHaveBeenCalled();
  });
});

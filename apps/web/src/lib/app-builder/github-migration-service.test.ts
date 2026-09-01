jest.mock('@/lib/drizzle', () => ({
  db: {
    update: jest.fn(() => ({
      set: jest.fn(() => ({
        where: jest.fn(() => ({
          returning: jest
            .fn()
            .mockResolvedValue([{ id: 'project-1', deployment_id: null, session_id: 'session-1' }]),
        })),
      })),
    })),
  },
}));
jest.mock('@/lib/app-builder/project-ownership', () => ({
  getProjectWithOwnershipCheck: jest.fn(),
}));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: jest.fn(),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchGitHubInstallationDetails: jest.fn(),
  fetchGitHubRepositories: jest.fn(),
  getInstallationSettingsUrl: jest.fn(),
  getRepositoryDetails: jest.fn(),
}));
jest.mock('@/lib/app-builder/app-builder-client', () => {
  class AppBuilderError extends Error {
    constructor(
      message: string,
      public statusCode?: number
    ) {
      super(message);
    }
  }

  return {
    AppBuilderError,
    migrateToGithub: jest.fn(),
  };
});

import * as appBuilderClient from '@/lib/app-builder/app-builder-client';
import { getProjectWithOwnershipCheck } from '@/lib/app-builder/project-ownership';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import { getRepositoryDetails } from '@/lib/integrations/platforms/github/adapter';
import { migrateProjectToGitHub } from './github-migration-service';

const sensitiveUrl = 'https://oauth2:secret-token@github.com/owner/repo.git';
const params = {
  projectId: 'project-1',
  owner: { type: 'user' as const, id: 'user-1' },
  userId: 'user-1',
  repoFullName: 'owner/repo',
};

describe('migrateProjectToGitHub error logging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getProjectWithOwnershipCheck).mockResolvedValue({} as never);
    jest.mocked(getIntegrationForOwner).mockResolvedValue({
      id: 'integration-1',
      platform_installation_id: 'installation-1',
    } as never);
    jest.mocked(getRepositoryDetails).mockResolvedValue({
      fullName: 'owner/repo',
      cloneUrl: 'https://github.com/owner/repo.git',
      htmlUrl: 'https://github.com/owner/repo',
      isEmpty: true,
      isPrivate: true,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['push_failed', 'push_failed'],
    ['invalid_request', 'internal_error'],
    ['token_failed', 'internal_error'],
    ['internal_error', 'internal_error'],
  ] as const)(
    'maps Worker %s to %s without logging its message',
    async (workerError, publicError) => {
      jest.mocked(appBuilderClient.migrateToGithub).mockResolvedValue({
        success: false,
        error: workerError,
        message: `push rejected ${sensitiveUrl}`,
      });
      const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(migrateProjectToGitHub(params)).resolves.toEqual({
        success: false,
        error: publicError,
      });

      expect(errorSpy).toHaveBeenCalledWith(`Migration failed (${publicError}):`, {
        source: 'app_builder_response',
        workerError,
      });
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sensitiveUrl);
    }
  );

  it('logs a safe transport representation without the original error', async () => {
    jest
      .mocked(appBuilderClient.migrateToGithub)
      .mockRejectedValue(new Error(`request failed for ${sensitiveUrl}`));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(migrateProjectToGitHub(params)).resolves.toEqual({
      success: false,
      error: 'internal_error',
    });

    expect(errorSpy).toHaveBeenCalledWith('Migration failed (internal_error):', {
      source: 'app_builder_request',
    });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sensitiveUrl);
  });
});

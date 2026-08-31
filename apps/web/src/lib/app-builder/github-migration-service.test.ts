jest.mock('@/lib/drizzle', () => ({
  db: { update: jest.fn() },
}));
jest.mock('@/lib/app-builder/app-builder-client', () => ({
  migrateToGithub: jest.fn(),
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

import { db } from '@/lib/drizzle';
import * as appBuilderClient from '@/lib/app-builder/app-builder-client';
import { getProjectWithOwnershipCheck } from '@/lib/app-builder/project-ownership';
import { getIntegrationForOwner } from '@/lib/integrations/db/platform-integrations';
import { getRepositoryDetails } from '@/lib/integrations/platforms/github/adapter';
import { migrateProjectToGitHub } from './github-migration-service';

describe('migrateProjectToGitHub Worker error mapping', () => {
  const cleanupSet = jest.fn();

  beforeEach(() => {
    jest.resetAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    jest.mocked(getProjectWithOwnershipCheck).mockResolvedValue({} as never);
    jest.mocked(getIntegrationForOwner).mockResolvedValue({
      id: 'integration-id',
      platform_installation_id: 'installation-id',
    } as never);
    jest.mocked(getRepositoryDetails).mockResolvedValue({
      fullName: 'kilocode/example',
      cloneUrl: 'https://github.com/kilocode/example.git',
      htmlUrl: 'https://github.com/kilocode/example',
      isEmpty: true,
      isPrivate: true,
    });

    const claim = {
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest
            .fn()
            .mockResolvedValue([{ deployment_id: null, session_id: 'session-id' }]),
        }),
      }),
    };
    cleanupSet.mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
    /* eslint-disable drizzle/enforce-update-with-where -- This configures the query mock. */
    jest
      .mocked(db.update)
      .mockReturnValueOnce(claim as never)
      .mockReturnValueOnce({ set: cleanupSet } as never);
    /* eslint-enable drizzle/enforce-update-with-where */
  });

  it.each([
    ['push_failed', 'push_failed'],
    ['invalid_request', 'internal_error'],
    ['token_failed', 'internal_error'],
    ['internal_error', 'internal_error'],
  ] as const)('maps Worker %s to public %s', async (workerError, publicError) => {
    jest.mocked(appBuilderClient.migrateToGithub).mockResolvedValue({
      success: false,
      error: workerError,
      message: 'sensitive detail',
    });

    await expect(
      migrateProjectToGitHub({
        projectId: 'project-id',
        owner: { type: 'user', id: 'user_2abc123' },
        userId: 'user_2abc123',
        repoFullName: 'kilocode/example',
      })
    ).resolves.toEqual({ success: false, error: publicError });
    expect(cleanupSet).toHaveBeenCalledWith({ migrated_at: null });
  });

  it('maps transport errors to internal_error', async () => {
    jest
      .mocked(appBuilderClient.migrateToGithub)
      .mockRejectedValue(new Error('sensitive transport detail'));

    await expect(
      migrateProjectToGitHub({
        projectId: 'project-id',
        owner: { type: 'user', id: 'user_2abc123' },
        userId: 'user_2abc123',
        repoFullName: 'kilocode/example',
      })
    ).resolves.toEqual({ success: false, error: 'internal_error' });
  });
});

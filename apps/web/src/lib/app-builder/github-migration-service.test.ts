import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type * as GitHubMigrationService from './github-migration-service';

const mockGetProjectWithOwnershipCheck = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetIntegrationForOwner = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetIntegrationsByOrganization = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockResolveOrganizationIntegration = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockUpdateRepositoriesForIntegration = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFetchInstallationDetails = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockFetchRepositories = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetRepositoryDetails = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockGetInstallationSettingsUrl = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockMigrateToGithub = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const returningRows: unknown[][] = [];
const mockReturning = jest.fn(async () => returningRows.shift() ?? []);
const mockWhere = jest.fn(() => ({ returning: mockReturning }));
const mockSet = jest.fn(() => ({ where: mockWhere }));

jest.mock('@/lib/drizzle', () => ({
  db: {
    update: jest.fn(() => ({ set: mockSet })),
  },
}));

jest.mock('@/lib/config.server', () => ({
  APP_BUILDER_URL: 'https://builder.example.com',
  APP_BUILDER_AUTH_TOKEN: 'test-auth',
}));

jest.mock('@/lib/app-builder/project-ownership', () => ({
  getProjectWithOwnershipCheck: (...args: unknown[]) => mockGetProjectWithOwnershipCheck(...args),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (...args: unknown[]) => mockGetIntegrationForOwner(...args),
  getIntegrationsByOrganization: (...args: unknown[]) => mockGetIntegrationsByOrganization(...args),
  resolveOrganizationGitHubIntegrationForRepository: (...args: unknown[]) =>
    mockResolveOrganizationIntegration(...args),
  updateRepositoriesForIntegration: (...args: unknown[]) =>
    mockUpdateRepositoriesForIntegration(...args),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchGitHubInstallationDetails: (...args: unknown[]) => mockFetchInstallationDetails(...args),
  fetchGitHubRepositories: (...args: unknown[]) => mockFetchRepositories(...args),
  getRepositoryDetails: (...args: unknown[]) => mockGetRepositoryDetails(...args),
  getInstallationSettingsUrl: (...args: unknown[]) => mockGetInstallationSettingsUrl(...args),
}));

jest.mock('@/lib/app-builder/app-builder-client', () => ({
  migrateToGithub: (...args: unknown[]) => mockMigrateToGithub(...args),
}));

let canMigrateToGitHub: typeof GitHubMigrationService.canMigrateToGitHub;
let migrateProjectToGitHub: typeof GitHubMigrationService.migrateProjectToGitHub;

const organizationId = '123e4567-e89b-12d3-a456-426614174001';
const standardIntegrationId = '123e4567-e89b-12d3-a456-426614174002';
const liteIntegrationId = '123e4567-e89b-12d3-a456-426614174003';

function integration(
  id: string,
  installationId: string,
  appType: 'standard' | 'lite',
  accountLogin: string
): PlatformIntegration {
  return {
    id,
    platform: 'github',
    integration_type: 'app',
    integration_status: 'active',
    platform_installation_id: installationId,
    platform_account_login: accountLogin,
    github_app_type: appType,
    suspended_at: null,
    auth_invalid_at: null,
  } as PlatformIntegration;
}

const standardIntegration = integration(
  standardIntegrationId,
  'installation-standard',
  'standard',
  'acme-core'
);
const liteIntegration = integration(liteIntegrationId, 'installation-lite', 'lite', 'acme-apps');
const project = {
  id: '123e4567-e89b-12d3-a456-426614174004',
  title: 'Identity test',
  git_repo_full_name: null,
  deployment_id: null,
  session_id: 'session-1',
};

beforeAll(async () => {
  ({ canMigrateToGitHub, migrateProjectToGitHub } = await import('./github-migration-service'));
});

beforeEach(() => {
  jest.clearAllMocks();
  returningRows.length = 0;
  mockGetProjectWithOwnershipCheck.mockResolvedValue(project);
  mockGetIntegrationsByOrganization.mockResolvedValue([standardIntegration, liteIntegration]);
  mockFetchInstallationDetails.mockImplementation(async (installationId: unknown) => ({
    account: {
      login: installationId === 'installation-lite' ? 'acme-apps' : 'acme-core',
      type: 'Organization',
    },
    repository_selection: installationId === 'installation-lite' ? 'selected' : 'all',
  }));
  mockGetInstallationSettingsUrl.mockResolvedValue('https://github.com/settings/installations/1');
  mockFetchRepositories.mockImplementation(async (installationId: unknown) =>
    installationId === 'installation-lite'
      ? [
          {
            id: 2,
            name: 'secondary',
            full_name: 'acme-apps/secondary',
            private: true,
            created_at: '2026-08-27T10:00:00.000Z',
          },
        ]
      : [
          {
            id: 1,
            name: 'primary',
            full_name: 'acme-core/primary',
            private: false,
            created_at: '2026-08-26T10:00:00.000Z',
          },
        ]
  );
});

describe('App Builder GitHub integration identity', () => {
  it('returns secondary repositories with their integration identity and preserves app type', async () => {
    const result = await canMigrateToGitHub(project.id, { type: 'org', id: organizationId });

    expect(result.availableRepos).toEqual([
      expect.objectContaining({
        fullName: 'acme-apps/secondary',
        platformIntegrationId: liteIntegrationId,
      }),
      expect.objectContaining({
        fullName: 'acme-core/primary',
        platformIntegrationId: standardIntegrationId,
      }),
    ]);
    expect(mockFetchRepositories).toHaveBeenCalledWith('installation-standard', 'standard');
    expect(mockFetchRepositories).toHaveBeenCalledWith('installation-lite', 'lite');
    expect(mockUpdateRepositoriesForIntegration).toHaveBeenCalledWith(
      liteIntegrationId,
      expect.arrayContaining([expect.objectContaining({ full_name: 'acme-apps/secondary' })])
    );
  });

  it('uses the exact secondary integration for validation and worker migration', async () => {
    returningRows.push([project]);
    mockResolveOrganizationIntegration.mockResolvedValue({
      success: true,
      integration: liteIntegration,
    });
    mockGetRepositoryDetails.mockResolvedValue({
      fullName: 'acme-apps/secondary',
      cloneUrl: 'https://github.com/acme-apps/secondary.git',
      htmlUrl: 'https://github.com/acme-apps/secondary',
      isEmpty: true,
      isPrivate: true,
    });
    mockMigrateToGithub.mockResolvedValue({ success: true });

    await expect(
      migrateProjectToGitHub({
        projectId: project.id,
        owner: { type: 'org', id: organizationId },
        userId: 'oauth/example-user',
        repoFullName: 'acme-apps/secondary',
        expectedPlatformIntegrationId: liteIntegrationId,
      })
    ).resolves.toMatchObject({ success: true });

    expect(mockResolveOrganizationIntegration).toHaveBeenCalledWith({
      organizationId,
      repositoryFullName: 'acme-apps/secondary',
      expectedPlatformIntegrationId: liteIntegrationId,
    });
    expect(mockGetRepositoryDetails).toHaveBeenCalledWith(
      'installation-lite',
      'acme-apps/secondary',
      'lite'
    );
    expect(mockMigrateToGithub).toHaveBeenCalledWith(project.id, {
      githubRepo: 'acme-apps/secondary',
      userId: 'oauth/example-user',
      orgId: organizationId,
      expectedPlatformIntegrationId: liteIntegrationId,
    });
  });

  it('does not fall back when the expected integration is stale', async () => {
    returningRows.push([project]);
    mockResolveOrganizationIntegration.mockResolvedValue({
      success: false,
      reason: 'no_installation_found',
    });

    await expect(
      migrateProjectToGitHub({
        projectId: project.id,
        owner: { type: 'org', id: organizationId },
        userId: 'user-1',
        repoFullName: 'acme-apps/secondary',
        expectedPlatformIntegrationId: liteIntegrationId,
      })
    ).resolves.toEqual({ success: false, error: 'github_integration_unavailable' });
    expect(mockGetRepositoryDetails).not.toHaveBeenCalled();
    expect(mockMigrateToGithub).not.toHaveBeenCalled();
  });
});

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createCallerFactory } from '@/lib/trpc/init';
import type { User } from '@kilocode/db/schema';
import type { Owner } from '@/lib/integrations/core/types';
import type { GitHubAppType } from '@/lib/integrations/platforms/github/app-selector';

type TestIntegration = {
  id: string;
  platform_installation_id: string;
  platform_account_login: string;
  github_app_type: GitHubAppType;
};

type InstallationDetails = {
  account: { id: number; login: string };
  permissions: Record<string, string>;
  events: string[];
  repository_selection: string;
  created_at: string;
};

const mockGetIntegrationForOwner =
  jest.fn<(owner: Owner, platform: string) => Promise<TestIntegration | null>>();
const mockUpsertPlatformIntegrationForOwner =
  jest.fn<(owner: Owner, details: Record<string, unknown>) => Promise<void>>();
const mockUpdateRepositoriesForIntegration =
  jest.fn<(integrationId: string, repositories: unknown[]) => Promise<void>>();
const mockFetchGitHubInstallationDetails =
  jest.fn<(installationId: string, appType: GitHubAppType) => Promise<InstallationDetails>>();
const mockFetchGitHubRepositories =
  jest.fn<(installationId: string, appType: GitHubAppType) => Promise<unknown[]>>();

jest.mock('@/lib/integrations/github-apps-service', () => ({}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (owner: Owner, platform: string) =>
    mockGetIntegrationForOwner(owner, platform),
  upsertPlatformIntegrationForOwner: (owner: Owner, details: Record<string, unknown>) =>
    mockUpsertPlatformIntegrationForOwner(owner, details),
  updateRepositoriesForIntegration: (integrationId: string, repositories: unknown[]) =>
    mockUpdateRepositoriesForIntegration(integrationId, repositories),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchGitHubInstallationDetails: (installationId: string, appType: GitHubAppType) =>
    mockFetchGitHubInstallationDetails(installationId, appType),
  fetchGitHubRepositories: (installationId: string, appType: GitHubAppType) =>
    mockFetchGitHubRepositories(installationId, appType),
}));

let createCaller: (ctx: { user: User }) => {
  refreshInstallation: (input?: { organizationId?: string }) => Promise<{ success: boolean }>;
};

beforeAll(async () => {
  const mod = await import('./github-apps-router');
  createCaller = createCallerFactory(mod.githubAppsRouter);
});

describe('githubAppsRouter.refreshInstallation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetIntegrationForOwner.mockResolvedValue({
      id: 'integration-1',
      platform_installation_id: '98765',
      platform_account_login: 'old-owner',
      github_app_type: 'standard',
    });
    mockFetchGitHubInstallationDetails.mockResolvedValue({
      account: { id: 123, login: 'renamed-owner' },
      permissions: {},
      events: [],
      repository_selection: 'all',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    mockFetchGitHubRepositories.mockResolvedValue([]);
    mockUpsertPlatformIntegrationForOwner.mockResolvedValue(undefined);
    mockUpdateRepositoriesForIntegration.mockResolvedValue(undefined);
  });

  it('persists the current account login returned by GitHub', async () => {
    const caller = createCaller({ user: { id: 'user-1' } as User });

    await caller.refreshInstallation();

    expect(mockUpsertPlatformIntegrationForOwner).toHaveBeenCalledWith(
      { type: 'user', id: 'user-1' },
      expect.objectContaining({ platformAccountLogin: 'renamed-owner' })
    );
  });

  it('does not clear stored identity when GitHub returns no current account login', async () => {
    mockFetchGitHubInstallationDetails.mockResolvedValue({
      account: { id: 0, login: '' },
      permissions: {},
      events: [],
      repository_selection: 'all',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    const caller = createCaller({ user: { id: 'user-1' } as User });

    await expect(caller.refreshInstallation()).rejects.toThrow(
      'GitHub installation account identity unavailable'
    );

    expect(mockUpsertPlatformIntegrationForOwner).not.toHaveBeenCalled();
    expect(mockFetchGitHubRepositories).not.toHaveBeenCalled();
    expect(mockUpdateRepositoriesForIntegration).not.toHaveBeenCalled();
  });
});

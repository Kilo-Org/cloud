import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type {
  InstallationDeletedPayload,
  InstallationRepositoriesPayload,
  InstallationSuspendPayload,
  InstallationUnsuspendPayload,
} from '../webhook-schemas';
import type { GitHubAppType } from '../app-selector';

type GitHubIntegrationRow = {
  id: string;
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
  repositories?: { id: number; name: string; full_name: string; private: boolean }[] | null;
};

type GitHubOwner = { type: 'user' | 'org'; id: string };
type PlatformRepository = { id: number; name: string; full_name: string; private: boolean };

const mockFindIntegrationByInstallationId =
  jest.fn<
    (
      platform: string,
      installationId: string,
      appType: GitHubAppType
    ) => Promise<GitHubIntegrationRow | null>
  >();
const mockDeleteIntegration =
  jest.fn<
    (
      organizationId: string,
      platform: string,
      appType: GitHubAppType,
      installationId?: string
    ) => Promise<void>
  >();
const mockDeleteIntegrationForOwner =
  jest.fn<
    (
      owner: GitHubOwner,
      platform: string,
      appType: GitHubAppType,
      installationId?: string
    ) => Promise<void>
  >();
const mockSuspendIntegration =
  jest.fn<
    (
      organizationId: string,
      platform: string,
      suspendedBy: string,
      appType: GitHubAppType,
      installationId?: string
    ) => Promise<void>
  >();
const mockSuspendIntegrationForOwner =
  jest.fn<
    (
      owner: GitHubOwner,
      platform: string,
      suspendedBy: string,
      appType: GitHubAppType,
      installationId?: string
    ) => Promise<void>
  >();
const mockUnsuspendIntegration =
  jest.fn<
    (
      organizationId: string,
      platform: string,
      appType: GitHubAppType,
      installationId?: string
    ) => Promise<void>
  >();
const mockUnsuspendIntegrationForOwner =
  jest.fn<
    (
      owner: GitHubOwner,
      platform: string,
      appType: GitHubAppType,
      installationId?: string
    ) => Promise<void>
  >();
const mockUpdateIntegrationRepositories =
  jest.fn<
    (
      platform: string,
      installationId: string,
      repositories: PlatformRepository[],
      appType: GitHubAppType
    ) => Promise<void>
  >();
const mockBotInitialize = jest.fn<() => Promise<void>>();
const mockBotGetState = jest.fn<() => unknown>();
const mockUnlinkTeamKiloUsers =
  jest.fn<(state: unknown, platform: string, teamId: string) => Promise<number>>();
const mockCaptureException = jest.fn<(...args: unknown[]) => void>();
const mockLogExceptInTest = jest.fn<(...args: unknown[]) => void>();

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  findIntegrationByInstallationId: (
    platform: string,
    installationId: string,
    appType: GitHubAppType
  ) => mockFindIntegrationByInstallationId(platform, installationId, appType),
  autoCompleteInstallation: jest.fn(),
  deleteIntegration: (
    organizationId: string,
    platform: string,
    appType: GitHubAppType,
    installationId?: string
  ) => mockDeleteIntegration(organizationId, platform, appType, installationId),
  deleteIntegrationForOwner: (
    owner: GitHubOwner,
    platform: string,
    appType: GitHubAppType,
    installationId?: string
  ) => mockDeleteIntegrationForOwner(owner, platform, appType, installationId),
  suspendIntegration: (
    organizationId: string,
    platform: string,
    suspendedBy: string,
    appType: GitHubAppType,
    installationId?: string
  ) => mockSuspendIntegration(organizationId, platform, suspendedBy, appType, installationId),
  suspendIntegrationForOwner: (
    owner: GitHubOwner,
    platform: string,
    suspendedBy: string,
    appType: GitHubAppType,
    installationId?: string
  ) => mockSuspendIntegrationForOwner(owner, platform, suspendedBy, appType, installationId),
  unsuspendIntegration: (
    organizationId: string,
    platform: string,
    appType: GitHubAppType,
    installationId?: string
  ) => mockUnsuspendIntegration(organizationId, platform, appType, installationId),
  unsuspendIntegrationForOwner: (
    owner: GitHubOwner,
    platform: string,
    appType: GitHubAppType,
    installationId?: string
  ) => mockUnsuspendIntegrationForOwner(owner, platform, appType, installationId),
  updateRepositoriesForIntegration: jest.fn(),
  updateIntegrationRepositories: (
    platform: string,
    installationId: string,
    repositories: PlatformRepository[],
    appType: GitHubAppType
  ) => mockUpdateIntegrationRepositories(platform, installationId, repositories, appType),
}));

jest.mock('@/lib/bot', () => ({
  bot: {
    initialize: () => mockBotInitialize(),
    getState: () => mockBotGetState(),
  },
}));

jest.mock('@/lib/bot-identity', () => ({
  unlinkTeamKiloUsers: (state: unknown, platform: string, teamId: string) =>
    mockUnlinkTeamKiloUsers(state, platform, teamId),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

jest.mock('@/lib/utils.server', () => ({
  logExceptInTest: (...args: unknown[]) => mockLogExceptInTest(...args),
}));

let handleInstallationDeleted: (
  payload: InstallationDeletedPayload,
  appType: GitHubAppType
) => Promise<Response>;
let handleInstallationSuspend: (
  payload: InstallationSuspendPayload,
  appType: GitHubAppType
) => Promise<Response>;
let handleInstallationUnsuspend: (
  payload: InstallationUnsuspendPayload,
  appType: GitHubAppType
) => Promise<Response>;
let handleInstallationRepositories: (
  payload: InstallationRepositoriesPayload,
  appType: GitHubAppType
) => Promise<Response>;

beforeAll(async () => {
  ({ handleInstallationDeleted, handleInstallationSuspend, handleInstallationUnsuspend } =
    await import('./installation-handler'));
  ({ handleInstallationRepositories } = await import('./installation-repositories-handler'));
});

const deletedPayload = { action: 'deleted', installation: { id: 98765 } } as const;
const suspendPayload = {
  action: 'suspend',
  installation: { id: 98765 },
  sender: { id: 1, login: 'octocat' },
} as const;
const unsuspendPayload = { action: 'unsuspend', installation: { id: 98765 } } as const;

const orgIntegration: GitHubIntegrationRow = {
  id: 'pi_org',
  owned_by_organization_id: 'org_1',
  owned_by_user_id: null,
};
const userIntegration: GitHubIntegrationRow = {
  id: 'pi_user',
  owned_by_organization_id: null,
  owned_by_user_id: 'user_1',
};

describe('handleInstallationDeleted', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBotInitialize.mockResolvedValue(undefined);
    mockBotGetState.mockReturnValue({});
    mockUnlinkTeamKiloUsers.mockResolvedValue(0);
    mockDeleteIntegration.mockResolvedValue(undefined);
    mockDeleteIntegrationForOwner.mockResolvedValue(undefined);
  });

  it('standard app deletion unlinks bot identities and passes the app type', async () => {
    mockFindIntegrationByInstallationId.mockResolvedValue(orgIntegration);

    const response = await handleInstallationDeleted(deletedPayload, 'standard');

    expect(response.status).toBe(200);
    expect(mockFindIntegrationByInstallationId).toHaveBeenCalledWith('github', '98765', 'standard');
    expect(mockBotInitialize).toHaveBeenCalled();
    expect(mockUnlinkTeamKiloUsers).toHaveBeenCalledWith(expect.anything(), 'github', '98765');
    expect(mockDeleteIntegration).toHaveBeenCalledWith('org_1', 'github', 'standard', '98765');
    expect(mockDeleteIntegrationForOwner).not.toHaveBeenCalled();
  });

  it('lite app deletion does not unlink bot identities and passes the app type', async () => {
    mockFindIntegrationByInstallationId.mockResolvedValue(userIntegration);

    const response = await handleInstallationDeleted(deletedPayload, 'lite');

    expect(response.status).toBe(200);
    expect(mockFindIntegrationByInstallationId).toHaveBeenCalledWith('github', '98765', 'lite');
    expect(mockBotInitialize).not.toHaveBeenCalled();
    expect(mockUnlinkTeamKiloUsers).not.toHaveBeenCalled();
    expect(mockDeleteIntegrationForOwner).toHaveBeenCalledWith(
      { type: 'user', id: 'user_1' },
      'github',
      'lite',
      '98765'
    );
    expect(mockDeleteIntegration).not.toHaveBeenCalled();
  });
});

describe('handleInstallationSuspend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSuspendIntegration.mockResolvedValue(undefined);
    mockSuspendIntegrationForOwner.mockResolvedValue(undefined);
  });

  it('passes the webhook app type to the organization suspend helper', async () => {
    mockFindIntegrationByInstallationId.mockResolvedValue(orgIntegration);

    const response = await handleInstallationSuspend(suspendPayload, 'standard');

    expect(response.status).toBe(200);
    expect(mockFindIntegrationByInstallationId).toHaveBeenCalledWith('github', '98765', 'standard');
    expect(mockSuspendIntegration).toHaveBeenCalledWith(
      'org_1',
      'github',
      'octocat',
      'standard',
      '98765'
    );
    expect(mockSuspendIntegrationForOwner).not.toHaveBeenCalled();
  });

  it('passes the webhook app type to the user suspend helper', async () => {
    mockFindIntegrationByInstallationId.mockResolvedValue(userIntegration);

    const response = await handleInstallationSuspend(suspendPayload, 'lite');

    expect(response.status).toBe(200);
    expect(mockSuspendIntegrationForOwner).toHaveBeenCalledWith(
      { type: 'user', id: 'user_1' },
      'github',
      'octocat',
      'lite',
      '98765'
    );
    expect(mockSuspendIntegration).not.toHaveBeenCalled();
  });
});

describe('handleInstallationUnsuspend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUnsuspendIntegration.mockResolvedValue(undefined);
    mockUnsuspendIntegrationForOwner.mockResolvedValue(undefined);
  });

  it('passes the webhook app type to the organization unsuspend helper', async () => {
    mockFindIntegrationByInstallationId.mockResolvedValue(orgIntegration);

    const response = await handleInstallationUnsuspend(unsuspendPayload, 'lite');

    expect(response.status).toBe(200);
    expect(mockFindIntegrationByInstallationId).toHaveBeenCalledWith('github', '98765', 'lite');
    expect(mockUnsuspendIntegration).toHaveBeenCalledWith('org_1', 'github', 'lite', '98765');
    expect(mockUnsuspendIntegrationForOwner).not.toHaveBeenCalled();
  });

  it('passes the webhook app type to the user unsuspend helper', async () => {
    mockFindIntegrationByInstallationId.mockResolvedValue(userIntegration);

    const response = await handleInstallationUnsuspend(unsuspendPayload, 'standard');

    expect(response.status).toBe(200);
    expect(mockUnsuspendIntegrationForOwner).toHaveBeenCalledWith(
      { type: 'user', id: 'user_1' },
      'github',
      'standard',
      '98765'
    );
    expect(mockUnsuspendIntegration).not.toHaveBeenCalled();
  });
});

describe('handleInstallationRepositories', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindIntegrationByInstallationId.mockResolvedValue({
      id: 'pi_org',
      owned_by_organization_id: 'org_1',
      owned_by_user_id: null,
      repositories: [{ id: 1, name: 'keep', full_name: 'acme/keep', private: false }],
    });
    mockUpdateIntegrationRepositories.mockResolvedValue(undefined);
  });

  it('merges added repositories and passes the webhook app type', async () => {
    const response = await handleInstallationRepositories(
      {
        action: 'added',
        installation: { id: 98765 },
        repositories_added: [{ id: 2, name: 'new', full_name: 'acme/new', private: true }],
      },
      'standard'
    );

    expect(response.status).toBe(200);
    expect(mockFindIntegrationByInstallationId).toHaveBeenCalledWith('github', '98765', 'standard');
    expect(mockUpdateIntegrationRepositories).toHaveBeenCalledWith(
      'github',
      '98765',
      [
        { id: 1, name: 'keep', full_name: 'acme/keep', private: false },
        { id: 2, name: 'new', full_name: 'acme/new', private: true },
      ],
      'standard'
    );
  });

  it('removes repositories and passes the lite app type', async () => {
    const response = await handleInstallationRepositories(
      {
        action: 'removed',
        installation: { id: 98765 },
        repositories_removed: [{ id: 1, name: 'keep', full_name: 'acme/keep', private: false }],
      },
      'lite'
    );

    expect(response.status).toBe(200);
    expect(mockFindIntegrationByInstallationId).toHaveBeenCalledWith('github', '98765', 'lite');
    expect(mockUpdateIntegrationRepositories).toHaveBeenCalledWith('github', '98765', [], 'lite');
  });
});

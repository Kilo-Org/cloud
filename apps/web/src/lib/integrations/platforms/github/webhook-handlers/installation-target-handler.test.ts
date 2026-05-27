import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { GitHubAppType } from '../app-selector';
import type { InstallationTargetRenamedPayload } from '../webhook-schemas';

type InstallationAccountDetails = {
  account: { id: number; login: string };
};

const mockFetchGitHubInstallationDetails =
  jest.fn<
    (installationId: string, appType: GitHubAppType) => Promise<InstallationAccountDetails>
  >();
const mockUpdateIntegrationAccountIdentity =
  jest.fn<
    (
      integrationId: string,
      platformAccountId: string,
      platformAccountLogin: string
    ) => Promise<void>
  >();

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchGitHubInstallationDetails: (installationId: string, appType: GitHubAppType) =>
    mockFetchGitHubInstallationDetails(installationId, appType),
}));

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  updateIntegrationAccountIdentity: (
    integrationId: string,
    platformAccountId: string,
    platformAccountLogin: string
  ) => mockUpdateIntegrationAccountIdentity(integrationId, platformAccountId, platformAccountLogin),
}));

let handleInstallationTargetRenamed: (
  payload: InstallationTargetRenamedPayload,
  integrationId: string,
  appType: GitHubAppType
) => Promise<Response>;

beforeAll(async () => {
  ({ handleInstallationTargetRenamed } = await import('./installation-target-handler'));
});

describe('handleInstallationTargetRenamed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchGitHubInstallationDetails.mockResolvedValue({
      account: { id: 123, login: 'authoritative-current-owner' },
    });
    mockUpdateIntegrationAccountIdentity.mockResolvedValue(undefined);
  });

  it('persists the current installation identity fetched from GitHub', async () => {
    const response = await handleInstallationTargetRenamed(
      {
        action: 'renamed',
        installation: { id: 98765 },
        account: { id: 123, login: 'possibly-stale-webhook-owner' },
        changes: { login: { from: 'old-owner' } },
        target_type: 'User',
      },
      'integration-1',
      'lite'
    );

    expect(response.status).toBe(200);
    expect(mockFetchGitHubInstallationDetails).toHaveBeenCalledWith('98765', 'lite');
    expect(mockUpdateIntegrationAccountIdentity).toHaveBeenCalledWith(
      'integration-1',
      '123',
      'authoritative-current-owner'
    );
  });

  it('does not overwrite stored identity when GitHub returns no current login', async () => {
    mockFetchGitHubInstallationDetails.mockResolvedValue({
      account: { id: 123, login: '' },
    });

    await expect(
      handleInstallationTargetRenamed(
        {
          action: 'renamed',
          installation: { id: 98765 },
          account: {},
          changes: {},
          target_type: 'Organization',
        },
        'integration-1',
        'standard'
      )
    ).rejects.toThrow('GitHub installation account identity missing after rename event');

    expect(mockUpdateIntegrationAccountIdentity).not.toHaveBeenCalled();
  });
});

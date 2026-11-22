jest.mock('./app-selector', () => ({ getGitHubAppCredentials: jest.fn() }));

import { getGitHubAppCredentials } from './app-selector';
import {
  GitHubAppInstallationProtectedError,
  FORGE_FIXTURE_INSTALLATION_IDS_ENV,
} from './protected-installation';
import { deleteGitHubInstallation, verifyAndDeleteGitHubOrganizationInstallation } from './adapter';

const previous = process.env[FORGE_FIXTURE_INSTALLATION_IDS_ENV];

describe('the forge fixture installation guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env[FORGE_FIXTURE_INSTALLATION_IDS_ENV] = ' 175846100, 175846101,,nope ';
  });

  afterEach(() => {
    if (previous === undefined) delete process.env[FORGE_FIXTURE_INSTALLATION_IDS_ENV];
    else process.env[FORGE_FIXTURE_INSTALLATION_IDS_ENV] = previous;
    jest.useRealTimers();
  });

  test('refuses to delete the pool installation without reading credentials or calling GitHub', async () => {
    await expect(deleteGitHubInstallation('175846100')).rejects.toBeInstanceOf(
      GitHubAppInstallationProtectedError
    );
    await expect(
      verifyAndDeleteGitHubOrganizationInstallation({
        installationId: '175846101',
        accountId: '456',
        appType: 'standard',
      })
    ).rejects.toThrow('belongs to the local forge fixture app');
    // Every entry is compared as digits, so the malformed one protects nothing.
    expect(getGitHubAppCredentials).not.toHaveBeenCalled();
  });

  test('protects nothing when the stack names no fixture installation', async () => {
    delete process.env[FORGE_FIXTURE_INSTALLATION_IDS_ENV];
    jest.mocked(getGitHubAppCredentials).mockReturnValue({
      appId: '',
      appName: 'KiloConnect',
      clientId: '',
      clientSecret: '',
      privateKey: '',
      webhookSecret: '',
    });
    // Reaching the credential read proves the guard let the id through; the missing app id then stops the call.
    await expect(deleteGitHubInstallation('175846100')).rejects.toThrow(
      'App credentials not configured'
    );
    expect(getGitHubAppCredentials).toHaveBeenCalledWith('standard');
  });
});

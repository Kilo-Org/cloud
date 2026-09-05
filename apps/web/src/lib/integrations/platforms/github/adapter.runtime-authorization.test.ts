const mockAuthorize = jest.fn();
const mockAuth = jest.fn();

jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn(() => mockAuth) }));
jest.mock('./app-selector', () => ({ getGitHubAppCredentials: jest.fn() }));
jest.mock('../../github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: (installationId: string, appType: string) =>
    mockAuthorize(installationId, appType),
}));

import { getGitHubAppCredentials } from './app-selector';
import { generateGitHubInstallationToken } from './adapter';

describe('generateGitHubInstallationToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(getGitHubAppCredentials).mockReturnValue({
      appId: '123',
      privateKey: 'private-key',
    } as never);
    mockAuth.mockResolvedValue({
      token: 'installation-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
  });

  it('authorizes each mint before creating an installation token', async () => {
    await expect(generateGitHubInstallationToken('installation-1')).resolves.toEqual({
      token: 'installation-token',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    expect(mockAuthorize).toHaveBeenCalledWith('installation-1', 'standard');
  });

  it('denies a locally disconnected installation before token minting', async () => {
    mockAuthorize.mockRejectedValueOnce(
      new Error('GitHub installation is unavailable for runtime use')
    );

    await expect(generateGitHubInstallationToken('installation-1')).rejects.toThrow(
      'GitHub installation is unavailable for runtime use'
    );
    expect(mockAuth).not.toHaveBeenCalled();
  });
});

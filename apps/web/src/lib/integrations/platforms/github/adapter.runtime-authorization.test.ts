const mockAuthorize = jest.fn();
const mockAuth = jest.fn();
const mockPermission = jest.fn();

jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn(() => mockAuth) }));
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn(() => ({ repos: { getCollaboratorPermissionLevel: mockPermission } })),
}));
jest.mock('./app-selector', () => ({ getGitHubAppCredentials: jest.fn() }));
jest.mock('../../github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: (...args: unknown[]) => mockAuthorize(...args),
}));

import { getGitHubAppCredentials } from './app-selector';
import { generateGitHubInstallationToken, getCollaboratorPermissionLevel } from './adapter';

describe('GitHub installation authorization', () => {
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
    mockPermission.mockResolvedValue({ data: { permission: 'write' } });
  });

  it('authorizes each mint before creating an installation token', async () => {
    await expect(generateGitHubInstallationToken('installation-1')).resolves.toEqual({
      token: 'installation-token',
      expires_at: '2099-01-01T00:00:00.000Z',
    });
    expect(mockAuthorize).toHaveBeenCalledWith('installation-1', 'standard', undefined, 'workflow');
  });

  it('forwards the caller purpose and association to the authorization', async () => {
    await generateGitHubInstallationToken('installation-1', 'standard', 'pi_1', 'agent');

    expect(mockAuthorize).toHaveBeenCalledWith('installation-1', 'standard', 'pi_1', 'agent');
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

  it('uses default token authorization for collaborator permission lookups', async () => {
    await expect(
      getCollaboratorPermissionLevel(
        'installation-1',
        'acme',
        'widgets',
        'octocat',
        'standard',
        'pi_1'
      )
    ).resolves.toBe('write');

    expect(mockAuthorize).toHaveBeenCalledWith('installation-1', 'standard', 'pi_1', 'workflow');
    expect(mockPermission).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      username: 'octocat',
    });
  });

  it('does not look up collaborator permission when installation authorization fails', async () => {
    mockAuthorize.mockRejectedValueOnce(
      new Error('GitHub installation is unavailable for runtime use')
    );

    await expect(
      getCollaboratorPermissionLevel(
        'installation-1',
        'acme',
        'widgets',
        'octocat',
        'standard',
        'pi_1'
      )
    ).resolves.toBeNull();

    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockPermission).not.toHaveBeenCalled();
  });
});

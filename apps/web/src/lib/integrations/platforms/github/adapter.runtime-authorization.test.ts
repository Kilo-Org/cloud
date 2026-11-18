const mockAuthorize = jest.fn();
const mockAuth = jest.fn();
const mockPermission = jest.fn();

jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn(() => mockAuth) }));
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn(() => ({ repos: { getCollaboratorPermissionLevel: mockPermission } })),
}));
jest.mock('./app-selector', () => ({ getGitHubAppCredentials: jest.fn() }));
jest.mock('../../github/runtime-authorization', () => ({
  GitHubRuntimeAuthorizationError: class GitHubRuntimeAuthorizationError extends Error {},
  assertGitHubInstallationRuntimeAuthorized: (...args: unknown[]) => mockAuthorize(...args),
}));

import { getGitHubAppCredentials } from './app-selector';
import {
  generateGitHubInstallationToken,
  getCollaboratorPermissionLevel,
  GitHubRateLimitError,
} from './adapter';
import { GitHubRuntimeAuthorizationError } from '../../github/runtime-authorization';

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
    ).rejects.toThrow('GitHub installation is unavailable for runtime use');

    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockPermission).not.toHaveBeenCalled();
  });

  it('treats an unknown collaborator as no answer', async () => {
    mockPermission.mockRejectedValueOnce({ status: 404, message: 'Not Found' });

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).resolves.toBeNull();
  });

  it('treats a lookup 401 as no answer', async () => {
    mockPermission.mockRejectedValueOnce({ status: 401, message: 'Bad credentials' });

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).resolves.toBeNull();
  });

  it('treats a lookup 403 without rate-limit headers as no answer', async () => {
    mockPermission.mockRejectedValueOnce({
      status: 403,
      message: 'Resource not accessible by integration',
    });

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).resolves.toBeNull();
  });

  it('treats a lookup 422 as no answer', async () => {
    mockPermission.mockRejectedValueOnce({ status: 422, message: 'Validation Failed' });

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).resolves.toBeNull();
  });

  it('throws a rate-limit failure instead of reporting no answer', async () => {
    mockPermission.mockRejectedValueOnce({
      status: 429,
      message: 'rate limit exceeded',
      response: { headers: {} },
    });

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it('throws a server failure instead of reporting no answer', async () => {
    const serverError = { status: 502, message: 'Bad gateway' };
    mockPermission.mockRejectedValueOnce(serverError);

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).rejects.toBe(serverError);
  });

  it('returns no answer when the token mint answers 404 for the installation', async () => {
    mockAuth.mockRejectedValueOnce({ status: 404, message: 'Not Found' });

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).resolves.toBeNull();
    expect(mockPermission).not.toHaveBeenCalled();
  });

  it('returns no answer when the token mint rejects the runtime authorization', async () => {
    mockAuthorize.mockRejectedValueOnce(new GitHubRuntimeAuthorizationError('suspended'));

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).resolves.toBeNull();
    expect(mockAuth).not.toHaveBeenCalled();
    expect(mockPermission).not.toHaveBeenCalled();
  });

  it('returns no answer when the token mint answers 401 for the installation', async () => {
    mockAuth.mockRejectedValueOnce({ status: 401, message: 'Bad credentials' });

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).resolves.toBeNull();
    expect(mockPermission).not.toHaveBeenCalled();
  });

  it('returns no answer when the token mint answers 403 without rate-limit headers', async () => {
    mockAuth.mockRejectedValueOnce({
      status: 403,
      message: 'Resource not accessible by integration',
    });

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).resolves.toBeNull();
    expect(mockPermission).not.toHaveBeenCalled();
  });

  it('returns no answer when the token mint answers 422 for the installation', async () => {
    mockAuth.mockRejectedValueOnce({ status: 422, message: 'Validation Failed' });

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).resolves.toBeNull();
    expect(mockPermission).not.toHaveBeenCalled();
  });

  it('throws a rate-limited token mint instead of reporting no answer', async () => {
    mockAuth.mockRejectedValueOnce({
      status: 429,
      message: 'rate limit exceeded',
      response: { headers: {} },
    });

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).rejects.toBeInstanceOf(GitHubRateLimitError);
    expect(mockPermission).not.toHaveBeenCalled();
  });

  it('throws a server-failed token mint instead of reporting no answer', async () => {
    const mintError = { status: 502, message: 'Bad gateway' };
    mockAuth.mockRejectedValueOnce(mintError);

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).rejects.toBe(mintError);
    expect(mockPermission).not.toHaveBeenCalled();
  });

  it('throws a network-failed token mint instead of reporting no answer', async () => {
    const mintError = new Error('getaddrinfo EAI_AGAIN api.github.com');
    mockAuth.mockRejectedValueOnce(mintError);

    await expect(
      getCollaboratorPermissionLevel('installation-1', 'acme', 'widgets', 'octocat')
    ).rejects.toBe(mintError);
    expect(mockPermission).not.toHaveBeenCalled();
  });
});

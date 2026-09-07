const mockRequest = jest.fn();
const mockAuth = jest.fn();
const mockCreateAppAuth = jest.fn();
const mockGetGitHubAppCredentials = jest.fn();

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: (...args: unknown[]) => mockCreateAppAuth(...args),
}));
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn(() => ({ request: (...args: unknown[]) => mockRequest(...args) })),
}));
jest.mock('@/lib/integrations/platforms/github/app-selector', () => ({
  getGitHubAppCredentials: (...args: unknown[]) => mockGetGitHubAppCredentials(...args),
}));

import { lookupGitHubOrganizationInstallationForApp } from './github-installation-lookup';

const credentials = {
  appId: '123',
  privateKey: 'private-key',
  clientId: '',
  clientSecret: '',
  appName: 'KiloConnect',
  webhookSecret: '',
};

describe('lookupGitHubOrganizationInstallationForApp', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGitHubAppCredentials.mockReturnValue(credentials);
    mockCreateAppAuth.mockReturnValue(mockAuth);
    mockAuth.mockResolvedValue({ token: 'app-jwt' });
  });

  test('uses app authentication and the organization-only installation endpoint', async () => {
    mockRequest.mockResolvedValue({
      data: {
        id: 101,
        account: { id: 501, login: 'acme', type: 'Organization' },
        suspended_at: null,
        repository_selection: 'all',
      },
    });

    await expect(lookupGitHubOrganizationInstallationForApp('standard', 'acme')).resolves.toEqual({
      appType: 'standard',
      status: 'installed',
      installation: {
        id: '101',
        accountId: '501',
        accountLogin: 'acme',
        accountType: 'Organization',
        suspendedAt: null,
        repositorySelection: 'all',
      },
    });
    expect(mockAuth).toHaveBeenCalledWith({ type: 'app' });
    expect(mockRequest).toHaveBeenCalledWith(
      'GET /orgs/{org}/installation',
      expect.objectContaining({ org: 'acme' })
    );
  });

  test.each([
    [401, 'authentication_failed'],
    [403, 'authentication_failed'],
    [429, 'upstream_error'],
    [500, 'upstream_error'],
    [404, 'not_found_for_app'],
  ] as const)('maps HTTP %s to safe %s', async (status, reason) => {
    mockRequest.mockRejectedValue({ status, message: 'secret upstream response' });

    const result = await lookupGitHubOrganizationInstallationForApp('lite', 'acme');

    expect(result).toEqual({
      appType: 'lite',
      status: status === 404 ? 'not_found' : 'unknown',
      reason,
    });
    expect(JSON.stringify(result)).not.toContain('secret upstream response');
  });

  test('maps aborted requests and malformed account payloads to unknown', async () => {
    mockRequest.mockRejectedValueOnce(new DOMException('aborted', 'AbortError'));
    await expect(lookupGitHubOrganizationInstallationForApp('standard', 'acme')).resolves.toEqual({
      appType: 'standard',
      status: 'unknown',
      reason: 'request_timeout',
    });

    mockRequest.mockResolvedValueOnce({
      data: { id: 101, account: { id: 501, login: 'acme', type: 'User' } },
    });
    await expect(lookupGitHubOrganizationInstallationForApp('standard', 'acme')).resolves.toEqual({
      appType: 'standard',
      status: 'unknown',
      reason: 'malformed_response',
    });
  });

  test('does not request GitHub when app configuration is unavailable', async () => {
    mockGetGitHubAppCredentials.mockReturnValue({ ...credentials, appId: '' });

    await expect(lookupGitHubOrganizationInstallationForApp('standard', 'acme')).resolves.toEqual({
      appType: 'standard',
      status: 'unknown',
      reason: 'app_not_configured',
    });
    expect(mockCreateAppAuth).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

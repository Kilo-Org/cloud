const mockAuth = jest.fn();

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(() => mockAuth),
}));

jest.mock('@/lib/integrations/platforms/github/app-selector', () => ({
  getGitHubAppCredentials: jest.fn(() => ({
    appId: 'app-id',
    privateKey: 'private-key',
    webhookSecret: 'webhook-secret',
  })),
}));

import { generateGitHubInstallationToken } from './adapter';

describe('generateGitHubInstallationToken', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ token: 'token', expiresAt: '2099-01-01T00:00:00.000Z' });
  });

  it('requests a token scoped to the exact repository name', async () => {
    await generateGitHubInstallationToken('installation-1', 'lite', 'widgets');

    expect(mockAuth).toHaveBeenCalledWith({
      type: 'installation',
      repositoryNames: ['widgets'],
    });
  });

  it('preserves unscoped token minting for existing callers', async () => {
    await generateGitHubInstallationToken('installation-1', 'standard');

    expect(mockAuth).toHaveBeenCalledWith({ type: 'installation' });
  });
});

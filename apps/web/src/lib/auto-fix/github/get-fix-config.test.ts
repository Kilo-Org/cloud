const mockGetFixTicketById = jest.fn();
const mockResolveAutoFixGitHubIntegration = jest.fn();
const mockGenerateGitHubInstallationToken = jest.fn();

jest.mock('@/lib/auto-fix/db/fix-tickets', () => ({
  getFixTicketById: (...args: unknown[]) => mockGetFixTicketById(...args),
}));

jest.mock('./resolve-integration', () => ({
  resolveAutoFixGitHubIntegration: (...args: unknown[]) =>
    mockResolveAutoFixGitHubIntegration(...args),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: (...args: unknown[]) =>
    mockGenerateGitHubInstallationToken(...args),
}));

jest.mock('@/lib/agent-config/db/agent-configs', () => ({
  getAgentConfigForOwner: jest.fn(),
}));

jest.mock('@/lib/bot-users/bot-user-service', () => ({
  getBotUserId: jest.fn(),
}));

jest.mock('@/lib/utils.server', () => ({
  logExceptInTest: jest.fn(),
  errorExceptInTest: jest.fn(),
}));

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

import { getFixConfig } from './get-fix-config';

describe('getFixConfig installation resolution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetFixTicketById.mockResolvedValue({
      id: 'ticket-1',
      owned_by_organization_id: 'org-1',
      owned_by_user_id: null,
      platform_integration_id: null,
      repo_full_name: 'acme/widgets',
    });
  });

  it('fails closed when a legacy unpinned ticket matches multiple installations', async () => {
    mockResolveAutoFixGitHubIntegration.mockResolvedValue({
      success: false,
      reason: 'ambiguous_installation',
    });

    await expect(getFixConfig('ticket-1')).resolves.toEqual({
      ok: false,
      error: 'Multiple GitHub installations can access this repository',
      status: 409,
    });
    expect(mockGenerateGitHubInstallationToken).not.toHaveBeenCalled();
  });
});

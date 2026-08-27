const mockGetIntegrationForOwner = jest.fn();
const mockResolveOrganizationGitHubIntegrationForRepository = jest.fn();

jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationForOwner: (...args: unknown[]) => mockGetIntegrationForOwner(...args),
  resolveOrganizationGitHubIntegrationForRepository: (...args: unknown[]) =>
    mockResolveOrganizationGitHubIntegrationForRepository(...args),
}));

import { resolveIssueIntegration } from './fetch-issue';

describe('resolveIssueIntegration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the exact organization integration resolved for the issue repository', async () => {
    const integration = { id: 'secondary-integration', github_app_type: 'lite' };
    mockResolveOrganizationGitHubIntegrationForRepository.mockResolvedValue({
      success: true,
      integration,
    });

    await expect(
      resolveIssueIntegration({ type: 'org', id: 'org-1' }, 'acme-secondary/api')
    ).resolves.toEqual({ success: true, integration });
    expect(mockResolveOrganizationGitHubIntegrationForRepository).toHaveBeenCalledWith({
      organizationId: 'org-1',
      repositoryFullName: 'acme-secondary/api',
    });
    expect(mockGetIntegrationForOwner).not.toHaveBeenCalled();
  });

  it('preserves ambiguity instead of falling back to a primary installation', async () => {
    mockResolveOrganizationGitHubIntegrationForRepository.mockResolvedValue({
      success: false,
      reason: 'ambiguous_installation',
    });

    await expect(
      resolveIssueIntegration({ type: 'org', id: 'org-1' }, 'acme/api')
    ).resolves.toEqual({ success: false, reason: 'ambiguous_installation' });
    expect(mockGetIntegrationForOwner).not.toHaveBeenCalled();
  });
});

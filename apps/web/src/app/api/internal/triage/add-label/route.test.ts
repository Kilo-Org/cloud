const mockGetTriageTicketById = jest.fn();
const mockGetIntegrationById = jest.fn();
const mockGenerateGitHubInstallationToken = jest.fn();
const mockAddIssueLabel = jest.fn();

jest.mock('@/lib/config.server', () => ({ INTERNAL_API_SECRET: 'internal-secret' }));
jest.mock('@/lib/auto-triage/db/triage-tickets', () => ({
  getTriageTicketById: (...args: unknown[]) => mockGetTriageTicketById(...args),
}));
jest.mock('@/lib/integrations/db/platform-integrations', () => ({
  getIntegrationById: (...args: unknown[]) => mockGetIntegrationById(...args),
}));
jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: (...args: unknown[]) =>
    mockGenerateGitHubInstallationToken(...args),
}));
jest.mock('@/lib/auto-triage/github/add-label', () => ({
  addIssueLabel: (...args: unknown[]) => mockAddIssueLabel(...args),
}));

import { POST } from './route';

describe('POST /api/internal/triage/add-label', () => {
  it('uses the exact integration id and app type persisted on the ticket', async () => {
    const ticketId = '00000000-0000-4000-8000-000000000001';
    const integrationId = '00000000-0000-4000-8000-000000000002';
    mockGetTriageTicketById.mockResolvedValue({
      platform_integration_id: integrationId,
      repo_full_name: 'acme/widgets',
      issue_number: 7,
    });
    mockGetIntegrationById.mockResolvedValue({
      platform_installation_id: '123',
      github_app_type: 'lite',
    });
    mockGenerateGitHubInstallationToken.mockResolvedValue({ token: 'lite-token' });
    mockAddIssueLabel.mockResolvedValue(undefined);

    const response = await POST(
      new Request('https://app.example.test/api/internal/triage/add-label', {
        method: 'POST',
        headers: { 'X-Internal-Secret': 'internal-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketId, labels: ['triaged'] }),
      }) as never
    );

    expect(response.status).toBe(200);
    expect(mockGetIntegrationById).toHaveBeenCalledWith(integrationId);
    expect(mockGenerateGitHubInstallationToken).toHaveBeenCalledWith('123', 'lite');
    expect(mockAddIssueLabel).toHaveBeenCalledWith({
      repoFullName: 'acme/widgets',
      issueNumber: 7,
      label: 'triaged',
      githubToken: 'lite-token',
    });
  });
});

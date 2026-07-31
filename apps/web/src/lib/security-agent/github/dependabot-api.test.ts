import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPaginate = jest.fn() as jest.MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockListAlertsForRepo = jest.fn() as jest.MockedFunction<
  (...args: unknown[]) => Promise<unknown>
>;
const mockGenerateGitHubInstallationToken = jest.fn(async () => ({ token: 'token' }));
const mockWarnExceptInTest = jest.fn();
const mockErrorExceptInTest = jest.fn();
const mockSentryLog = jest.fn();
const mockSentryLogger = jest.fn(() => mockSentryLog);

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    paginate: mockPaginate,
    rest: {
      dependabot: {
        listAlertsForRepo: mockListAlertsForRepo,
      },
    },
  })),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: mockGenerateGitHubInstallationToken,
}));

jest.mock('@/lib/utils.server', () => ({
  sentryLogger: mockSentryLogger,
  warnExceptInTest: mockWarnExceptInTest,
  errorExceptInTest: mockErrorExceptInTest,
}));

describe('dependabot-api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('classifies 401 as auth_invalid and preserves existing skip classifications', async () => {
    const { classifyFetchAlertsError } = await import('./dependabot-api');

    expect(classifyFetchAlertsError(401, 'Bad credentials')).toBe('auth_invalid');
    expect(classifyFetchAlertsError(404, 'Not Found')).toBe('repo_not_found');
    expect(classifyFetchAlertsError(451, 'Unavailable For Legal Reasons')).toBe('access_blocked');
    expect(classifyFetchAlertsError(403, 'Repository access blocked')).toBe('access_blocked');
    expect(classifyFetchAlertsError(422, 'Dependabot alerts are disabled')).toBe('alerts_disabled');
    expect(classifyFetchAlertsError(403, 'Dependabot alerts are not available')).toBe(
      'alerts_disabled'
    );
  });

  it('returns auth_invalid for 401 without throwing or Sentry logging', async () => {
    const { fetchAllDependabotAlerts } = await import('./dependabot-api');
    mockPaginate.mockRejectedValueOnce({ status: 401, message: 'Bad credentials' });

    await expect(fetchAllDependabotAlerts('inst-1', 'acme', 'widgets')).resolves.toEqual({
      status: 'auth_invalid',
    });

    expect(mockWarnExceptInTest).toHaveBeenCalledWith(
      'GitHub App installation auth invalid for acme/widgets, skipping',
      expect.objectContaining({ status: 401, message: 'Bad credentials' })
    );
    expect(mockErrorExceptInTest).not.toHaveBeenCalled();
    expect(mockSentryLog).toHaveBeenCalledWith('Fetching alerts for acme/widgets', {
      installationId: 'inst-1',
    });
    expect(mockSentryLog).toHaveBeenCalledTimes(1);
  });

  it('reports enabled only when the Dependabot alerts endpoint succeeds', async () => {
    const { checkDependabotAlertsAvailability } = await import('./dependabot-api');
    mockListAlertsForRepo.mockResolvedValueOnce({ data: [] });
    mockListAlertsForRepo.mockRejectedValueOnce({
      status: 422,
      message: 'Dependabot alerts are disabled for this repository',
    });
    mockListAlertsForRepo.mockRejectedValueOnce({ status: 403, message: 'Forbidden' });

    await expect(
      checkDependabotAlertsAvailability('inst-1', 'standard', [
        { id: 1, fullName: 'acme/enabled' },
        { id: 2, fullName: 'acme/disabled' },
        { id: 3, fullName: 'acme/unknown' },
      ])
    ).resolves.toEqual([
      { id: 1, status: 'enabled' },
      { id: 2, status: 'disabled' },
      { id: 3, status: 'unknown' },
    ]);

    expect(mockListAlertsForRepo).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'enabled',
      state: 'open',
      per_page: 1,
    });
  });

  it('reuses a recent repository result without another GitHub request', async () => {
    const { checkDependabotAlertsAvailability } = await import('./dependabot-api');
    mockListAlertsForRepo.mockResolvedValue({ data: [] });
    const repositories = [{ id: 1, fullName: 'cache-test/widgets' }];

    await expect(
      checkDependabotAlertsAvailability('cache-installation', 'standard', repositories)
    ).resolves.toEqual([{ id: 1, status: 'enabled' }]);
    await expect(
      checkDependabotAlertsAvailability('cache-installation', 'standard', repositories)
    ).resolves.toEqual([{ id: 1, status: 'enabled' }]);

    expect(mockGenerateGitHubInstallationToken).toHaveBeenCalledTimes(1);
    expect(mockListAlertsForRepo).toHaveBeenCalledTimes(1);
  });

  it('keeps every repository unknown when GitHub authentication fails', async () => {
    const { checkDependabotAlertsAvailability } = await import('./dependabot-api');
    mockGenerateGitHubInstallationToken.mockRejectedValueOnce(new Error('auth unavailable'));

    await expect(
      checkDependabotAlertsAvailability('auth-failure-installation', 'standard', [
        { id: 1, fullName: 'auth-failure/widgets' },
      ])
    ).resolves.toEqual([{ id: 1, status: 'unknown' }]);

    expect(mockListAlertsForRepo).not.toHaveBeenCalled();
  });

  it('isolates malformed repository names instead of failing the whole check', async () => {
    const { checkDependabotAlertsAvailability } = await import('./dependabot-api');
    mockListAlertsForRepo.mockResolvedValueOnce({ data: [] });

    await expect(
      checkDependabotAlertsAvailability('malformed-installation', 'standard', [
        { id: 1, fullName: undefined as never },
        { id: 2, fullName: 'acme/valid' },
      ])
    ).resolves.toEqual([
      { id: 1, status: 'unknown' },
      { id: 2, status: 'enabled' },
    ]);
  });
});

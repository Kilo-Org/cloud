import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

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

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
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

  describe('probing budget', () => {
    const repositoriesNamed = (owner: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        fullName: `${owner}/repo-${index + 1}`,
      }));

    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns fast probe results without waiting for the budget', async () => {
      const { checkDependabotAlertsAvailability } = await import('./dependabot-api');
      mockListAlertsForRepo.mockResolvedValue({ data: [] });
      const repositories = repositoriesNamed('fast-budget', 30);

      await expect(
        checkDependabotAlertsAvailability('fast-budget-installation', 'standard', repositories)
      ).resolves.toEqual(
        repositories.map(repository => ({ id: repository.id, status: 'enabled' }))
      );

      expect(mockListAlertsForRepo).toHaveBeenCalledTimes(30);
      expect(jest.getTimerCount()).toBe(0);
    });

    it('returns unknown for repositories not checked within the budget', async () => {
      const { checkDependabotAlertsAvailability } = await import('./dependabot-api');
      mockListAlertsForRepo.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve({ data: [] }), 1_500))
      );
      const repositories = repositoriesNamed('slow-budget', 30);

      const firstCheck = checkDependabotAlertsAvailability(
        'slow-budget-installation',
        'standard',
        repositories
      );
      await jest.advanceTimersByTimeAsync(5_000);

      // Five concurrent probes of 1.5 s each finish three batches before the 5 s budget.
      await expect(firstCheck).resolves.toEqual(
        repositories.map(repository => ({
          id: repository.id,
          status: repository.id <= 15 ? 'enabled' : 'unknown',
        }))
      );

      // The fourth batch was in flight at the deadline; queued probes never start.
      await jest.advanceTimersByTimeAsync(10_000);
      expect(mockListAlertsForRepo).toHaveBeenCalledTimes(20);

      // In-flight probes still populated the cache, so the next call checks only the rest.
      const secondCheck = checkDependabotAlertsAvailability(
        'slow-budget-installation',
        'standard',
        repositories
      );
      await jest.advanceTimersByTimeAsync(3_000);

      await expect(secondCheck).resolves.toEqual(
        repositories.map(repository => ({ id: repository.id, status: 'enabled' }))
      );
      expect(mockListAlertsForRepo).toHaveBeenCalledTimes(30);
    });
  });
});

import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockPaginate = jest.fn() as jest.MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
const mockWarnExceptInTest = jest.fn();
const mockErrorExceptInTest = jest.fn();
const mockSentryLog = jest.fn();
const mockSentryLogger = jest.fn(() => mockSentryLog);

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    paginate: mockPaginate,
    rest: {
      dependabot: {
        listAlertsForRepo: jest.fn(),
      },
    },
  })),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  generateGitHubInstallationToken: jest.fn(async () => ({ token: 'token' })),
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
});

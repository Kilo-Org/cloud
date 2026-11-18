import {
  lookupGitHubOrganizationInstallation,
  type GitHubOrganizationInstallationLookupResult,
} from './github-installation-lookup';

const checkedAt = new Date('2026-09-03T15:00:00.000Z');

function record(
  overrides: Partial<GitHubOrganizationInstallationLookupResult['records'][number]> = {}
): GitHubOrganizationInstallationLookupResult['records'][number] {
  return {
    id: 'record-1',
    appType: 'standard',
    installationId: '101',
    accountLogin: 'acme',
    accountId: '501',
    status: 'active',
    suspendedAt: null,
    authInvalid: false,
    updatedAt: checkedAt.toISOString(),
    owner: { type: 'organization', id: 'owner-1', name: 'Acme' },
    association: 'candidate',
    ...overrides,
  };
}

function installed(appType: 'standard' | 'lite', id = '101', accountId = '501') {
  return {
    appType,
    status: 'installed' as const,
    installation: {
      id,
      accountId,
      accountLogin: 'acme',
      accountType: 'Organization',
      suspendedAt: null,
      repositorySelection: 'all',
    },
  };
}

describe('lookupGitHubOrganizationInstallation', () => {
  test('checks both apps, returns bounded local candidates, and marks only exact app/id/account matches actual', async () => {
    const getInstallation = jest.fn(async (appType: 'standard' | 'lite') =>
      appType === 'standard'
        ? installed('standard')
        : { appType, status: 'not_found' as const, reason: 'not_found_for_app' as const }
    );
    const findRecords = jest.fn().mockResolvedValue({
      records: [
        record(),
        record({ id: 'legacy', appType: null }),
        record({ id: 'wrong-app', appType: 'lite' }),
      ],
      recordsTruncated: true,
    });

    const result = await lookupGitHubOrganizationInstallation('acme', {
      getInstallation,
      findRecords,
      now: () => checkedAt,
    });

    expect(getInstallation).toHaveBeenCalledTimes(2);
    expect(findRecords).toHaveBeenCalledWith({
      organization: 'acme',
      installationIds: ['101'],
      accountIds: ['501'],
    });
    expect(result).toMatchObject({
      organization: 'acme',
      checkedAt: checkedAt.toISOString(),
      recordsTruncated: true,
      apps: [installed('standard'), { appType: 'lite', status: 'not_found' }],
    });
    expect(result.records.map(item => item.association)).toEqual(['actual', 'actual', 'candidate']);
  });

  test('retains an unknown app result and does not claim global absence', async () => {
    const result = await lookupGitHubOrganizationInstallation('acme', {
      getInstallation: async appType =>
        appType === 'standard'
          ? { appType, status: 'not_found', reason: 'not_found_for_app' }
          : { appType, status: 'unknown', reason: 'request_timeout' },
      findRecords: async () => ({ records: [], recordsTruncated: false }),
      now: () => checkedAt,
    });

    expect(result.apps).toEqual([
      { appType: 'standard', status: 'not_found', reason: 'not_found_for_app' },
      { appType: 'lite', status: 'unknown', reason: 'request_timeout' },
    ]);
  });

  test('returns only safe upstream reason codes', async () => {
    const upstreamMessage = 'token secret-value failed at internal-host';
    const result = await lookupGitHubOrganizationInstallation('acme', {
      getInstallation: async appType => ({ appType, status: 'unknown', reason: 'upstream_error' }),
      findRecords: async () => ({ records: [record()], recordsTruncated: false }),
      now: () => checkedAt,
    });

    expect(JSON.stringify(result)).not.toContain(upstreamMessage);
    expect(
      result.apps.every(app => app.status === 'unknown' && app.reason === 'upstream_error')
    ).toBe(true);
  });
});

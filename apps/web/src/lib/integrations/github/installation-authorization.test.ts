import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { discoverAuthorizedGitHubInstallations as DiscoverAuthorizedGitHubInstallations } from './installation-authorization';
import type { verifyGitHubInstallationAuthorization as VerifyGitHubInstallationAuthorization } from './installation-authorization';
import {
  GITHUB_LISTING_TIMEOUT_MS,
  GitHubListingBudgetExceededError,
} from '@/lib/integrations/platforms/github/listing-budget';

const getAuthenticated = jest.fn<() => Promise<{ data: { id: number; login: string } }>>();
const listMemberships = jest.fn<
  (_params: {
    page: number;
    per_page: number;
    state: 'active';
    request: { signal: AbortSignal };
  }) => Promise<{
    data: Array<{
      state: string;
      role: string;
      organization: { id: number; login: string };
    }>;
  }>
>();
const listInstallations = jest.fn<
  (_params: { page: number; per_page: number; request: { signal: AbortSignal } }) => Promise<{
    data: {
      installations: Array<{
        id: number;
        app_id: number;
        account: { id: number; login: string; type: string };
      }>;
    };
  }>
>();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: {
      users: { getAuthenticated },
      orgs: { listMembershipsForAuthenticatedUser: listMemberships },
      apps: { listInstallationsForAuthenticatedUser: listInstallations },
    },
  })),
}));

let discoverAuthorizedGitHubInstallations: typeof DiscoverAuthorizedGitHubInstallations;
let verifyGitHubInstallationAuthorization: typeof VerifyGitHubInstallationAuthorization;

beforeAll(async () => {
  ({ discoverAuthorizedGitHubInstallations, verifyGitHubInstallationAuthorization } =
    await import('./installation-authorization'));
});

function page<T>(values: T[]) {
  return { data: values };
}

function installationPage(
  installations: Array<{
    id: number;
    app_id: number;
    account: { id: number; login: string; type: string };
  }>
) {
  return { data: { installations } };
}

describe('discoverAuthorizedGitHubInstallations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    getAuthenticated.mockResolvedValue({ data: { id: 12, login: 'owner' } });
    listMemberships.mockResolvedValue(
      page([{ state: 'active', role: 'admin', organization: { id: 99, login: 'allowed' } }])
    );
    listInstallations.mockResolvedValue(
      installationPage([
        {
          id: 44,
          app_id: 7,
          account: { id: 99, login: 'allowed', type: 'Organization' },
        },
      ])
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns only the configured app installation for an active organization owner', async () => {
    await expect(
      discoverAuthorizedGitHubInstallations({
        accessToken: 'token',
        githubAppType: 'standard',
        expectedAppId: '7',
      })
    ).resolves.toEqual({
      identity: { id: '12', login: 'owner' },
      candidates: [
        {
          installationId: '44',
          accountId: '99',
          accountLogin: 'allowed',
          accountType: 'Organization',
        },
      ],
    });
    expect(console.log).not.toHaveBeenCalled();
  });

  test.each([
    { state: 'active', role: 'member' },
    { state: 'pending', role: 'admin' },
  ])('rejects a visible installation without active owner membership: %o', async membership => {
    listMemberships.mockResolvedValueOnce(
      page([{ ...membership, organization: { id: 99, login: 'allowed' } }])
    );

    await expect(
      discoverAuthorizedGitHubInstallations({
        accessToken: 'token',
        githubAppType: 'standard',
        expectedAppId: '7',
      })
    ).resolves.toMatchObject({ candidates: [] });
  });

  test('rejects another GitHub App even when the user owns the account', async () => {
    listInstallations.mockResolvedValueOnce(
      installationPage([
        {
          id: 44,
          app_id: 8,
          account: { id: 99, login: 'allowed', type: 'Organization' },
        },
      ])
    );

    await expect(
      discoverAuthorizedGitHubInstallations({
        accessToken: 'token',
        githubAppType: 'standard',
        expectedAppId: '7',
      })
    ).resolves.toMatchObject({ candidates: [] });
  });

  test.each([false, true])('logs rejection safely with installation present: %s', async present => {
    if (!present) listInstallations.mockResolvedValueOnce(installationPage([]));
    listMemberships.mockResolvedValueOnce(
      page([
        { state: 'active', role: 'member', organization: { id: 99, login: 'allowed' } },
        { state: 'active', role: 'member', organization: { id: 101, login: 'unrelated-org' } },
      ])
    );
    await expect(
      verifyGitHubInstallationAuthorization({
        accessToken: 'secret-access-token',
        githubAppType: 'standard',
        expectedAppId: '7',
        installationId: '44',
      })
    ).resolves.toBeNull();

    expect(console.log).toHaveBeenCalledWith(
      '[github_admin_proof:discovery]',
      JSON.stringify({
        github_app_type: 'standard',
        expected_app_id: 7,
        github_user_id: '12',
        installation_id: '44',
        target: present
          ? {
              app_id: 7,
              app_id_matches: true,
              account_id: 99,
              account_type: 'Organization',
              account_login_present: true,
              active_membership_visible: true,
              membership_role: 'member',
              personal_account_matches_user: false,
              authorized_candidate: false,
            }
          : null,
      })
    );
    expect(console.log).toHaveBeenLastCalledWith(
      '[github_admin_proof:verification]',
      JSON.stringify({
        github_app_type: 'standard',
        installation_id: '44',
        expected_account_id: null,
        expected_account_type: null,
        result: 'installation_not_authorized',
      })
    );
    expect(console.log).toHaveBeenCalledTimes(2);
  });

  test('pages through two installations pages', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: 1000 + index,
      app_id: 7,
      account: { id: 500 + index, login: `org-${index}`, type: 'Organization' },
    }));
    listInstallations
      .mockResolvedValueOnce(installationPage(firstPage))
      .mockResolvedValueOnce(
        installationPage([
          { id: 44, app_id: 7, account: { id: 99, login: 'allowed', type: 'Organization' } },
        ])
      );

    const result = await discoverAuthorizedGitHubInstallations({
      accessToken: 'token',
      githubAppType: 'standard',
      expectedAppId: '7',
    });

    expect(result.candidates).toEqual([
      {
        installationId: '44',
        accountId: '99',
        accountLogin: 'allowed',
        accountType: 'Organization',
      },
    ]);
    expect(listInstallations).toHaveBeenCalledTimes(2);
    for (const [params] of listInstallations.mock.calls) {
      expect(params.request.signal).toBeInstanceOf(AbortSignal);
    }
    expect(listInstallations.mock.calls[0][0].page).toBe(1);
    expect(listInstallations.mock.calls[1][0].page).toBe(2);
  });

  test('stops at the page limit', async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({
      id: 1000 + index,
      app_id: 7,
      account: { id: 500 + index, login: `org-${index}`, type: 'Organization' },
    }));
    listInstallations.mockResolvedValue(installationPage(fullPage));

    const thrown: unknown = await discoverAuthorizedGitHubInstallations({
      accessToken: 'token',
      githubAppType: 'standard',
      expectedAppId: '7',
    }).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
    expect((thrown as Error).message).toBe(
      'GitHub pagination limit exceeded: installation administration listing returned more than 100 pages'
    );
    expect(listInstallations).toHaveBeenCalledTimes(100);
  });

  test('stops at the time limit', async () => {
    jest.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      listInstallations.mockImplementation((params: { request: { signal: AbortSignal } }) => {
        const { signal } = params.request;
        signals.push(signal);
        const { promise, reject } = Promise.withResolvers<never>();
        const abort = () => reject(signal.reason);
        if (signal.aborted) {
          abort();
          return promise;
        }
        signal.addEventListener('abort', abort, { once: true });
        return promise;
      });

      const discovery = discoverAuthorizedGitHubInstallations({
        accessToken: 'token',
        githubAppType: 'standard',
        expectedAppId: '7',
      });
      const settled = discovery.catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(GITHUB_LISTING_TIMEOUT_MS);
      const thrown: unknown = await settled;

      expect(thrown).toBeInstanceOf(GitHubListingBudgetExceededError);
      expect((thrown as Error).message).toBe(
        `GitHub pagination limit exceeded: installation administration listing did not finish within ${GITHUB_LISTING_TIMEOUT_MS / 1000} s`
      );
      expect(signals).toHaveLength(1);
      expect(signals[0].aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

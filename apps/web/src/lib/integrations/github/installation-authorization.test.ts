import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { discoverAuthorizedGitHubInstallations as DiscoverAuthorizedGitHubInstallations } from './installation-authorization';
import type { verifyGitHubInstallationAuthorization as VerifyGitHubInstallationAuthorization } from './installation-authorization';

const getAuthenticated = jest.fn<() => Promise<{ data: { id: number; login: string } }>>();
const listMemberships = jest.fn<
  () => Promise<{
    data: Array<{
      state: string;
      role: string;
      organization: { id: number; login: string };
    }>;
  }>
>();
const listInstallations = jest.fn<
  () => Promise<{
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
});

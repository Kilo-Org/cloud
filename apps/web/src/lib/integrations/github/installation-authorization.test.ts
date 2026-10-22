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

  test.each([false, true])(
    'rejects an installation without active owner membership through verification: %s',
    async present => {
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
    }
  );
});

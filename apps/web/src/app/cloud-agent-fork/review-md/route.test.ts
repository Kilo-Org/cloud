import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { NextRequest } from 'next/server';

type TrpcContextFixture = {
  user: {
    id: string;
  };
};

type ReviewConfigFixture = {
  customInstructions: string | null;
  modelSlug: string | null;
};

type RepositoriesFixture = {
  integrationInstalled: boolean;
  repositories: { id: number; name: string; fullName: string; private: boolean }[];
  syncedAt: string | null;
};

type PrepareSessionOutput = {
  kiloSessionId: string;
};

type RouteGet = (request: NextRequest) => Promise<Response>;

const mockCreateTRPCContext = jest.fn<() => Promise<TrpcContextFixture>>();
const mockPersonalGetReviewConfig =
  jest.fn<(input: { platform: string }) => Promise<ReviewConfigFixture>>();
const mockOrganizationGetReviewConfig =
  jest.fn<(input: { organizationId: string; platform: string }) => Promise<ReviewConfigFixture>>();
const mockPersonalListGitHubRepositories =
  jest.fn<(input: { forceRefresh: boolean }) => Promise<RepositoriesFixture>>();
const mockPersonalListGitLabRepositories =
  jest.fn<(input: { forceRefresh: boolean }) => Promise<RepositoriesFixture>>();
const mockOrganizationListGitHubRepositories =
  jest.fn<
    (input: { organizationId: string; forceRefresh: boolean }) => Promise<RepositoriesFixture>
  >();
const mockOrganizationListGitLabRepositories =
  jest.fn<
    (input: { organizationId: string; forceRefresh: boolean }) => Promise<RepositoriesFixture>
  >();
const mockPersonalPrepareSession = jest.fn<() => Promise<PrepareSessionOutput>>();
const mockOrganizationPrepareSession = jest.fn<() => Promise<PrepareSessionOutput>>();

const mockCaller = {
  organizations: {
    reviewAgent: {
      getReviewConfig: mockOrganizationGetReviewConfig,
      listGitHubRepositories: mockOrganizationListGitHubRepositories,
      listGitLabRepositories: mockOrganizationListGitLabRepositories,
    },
    cloudAgentNext: {
      prepareSession: mockOrganizationPrepareSession,
    },
  },
  personalReviewAgent: {
    getReviewConfig: mockPersonalGetReviewConfig,
    listGitHubRepositories: mockPersonalListGitHubRepositories,
    listGitLabRepositories: mockPersonalListGitLabRepositories,
  },
  cloudAgentNext: {
    prepareSession: mockPersonalPrepareSession,
  },
};
const mockCreateCaller = jest.fn((_: TrpcContextFixture) => mockCaller);
const mockCreateCallerFactory = jest.fn(() => mockCreateCaller);

jest.mock('@/lib/trpc/init', () => ({
  createTRPCContext: () => mockCreateTRPCContext(),
  createCallerFactory: () => mockCreateCallerFactory(),
}));

jest.mock('@/routers/root-router', () => ({
  rootRouter: {},
}));

jest.mock('@/lib/posthog-feature-flags', () => ({
  isFeatureFlagEnabledOrDevelopment: () => Promise.resolve(true),
}));

jest.mock('@/lib/redis', () => ({
  redisClient: {
    incr: () => Promise.resolve(1),
    expire: () => Promise.resolve(1),
  },
}));

jest.mock('@/lib/ai-gateway/models', () => ({
  PRIMARY_DEFAULT_MODEL: 'test/primary-default-model',
}));

let getRoute: RouteGet;

const USER_ID = 'user_1';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PERSONAL_KILO_SESSION_ID = 'ses_12345678901234567890123456';
const ORG_KILO_SESSION_ID = 'ses_abcdefabcdefabcdefabcdefab';

const repositories: RepositoriesFixture = {
  integrationInstalled: true,
  repositories: [{ id: 1, name: 'repo', fullName: 'owner/repo', private: false }],
  syncedAt: '2024-01-01T00:00:00Z',
};

const syncedEmptyRepositories: RepositoriesFixture = {
  integrationInstalled: true,
  repositories: [],
  syncedAt: '2024-01-01T00:00:00Z',
};

function makeRequest(params: {
  platform?: string;
  repo?: string;
  organizationId?: string;
  secFetchSite?: string | null;
}): NextRequest {
  const url = new URL('https://kilo.test/cloud-agent-fork/review-md');
  if (params.platform) url.searchParams.set('platform', params.platform);
  if (params.repo) url.searchParams.set('repo', params.repo);
  if (params.organizationId) url.searchParams.set('organizationId', params.organizationId);

  const headers = new Headers();
  const secFetchSite = params.secFetchSite === undefined ? 'same-origin' : params.secFetchSite;
  if (secFetchSite !== null) headers.set('sec-fetch-site', secFetchSite);

  return new NextRequest(url.toString(), { headers });
}

function getRedirectUrl(response: Response): URL {
  const location = response.headers.get('location');
  expect(location).toBeTruthy();
  // This route answers with a relative Location on purpose (the dev server's
  // origin differs from the browser's), so resolve it against the request origin.
  return new URL(location ?? '', 'https://kilo.test');
}

function expectErrorRedirect(response: Response, error: string) {
  const redirectUrl = getRedirectUrl(response);
  expect(`${redirectUrl.pathname}${redirectUrl.search}`).toBe(`/code-reviews?error=${error}`);
}

describe('GET /cloud-agent-fork/review-md', () => {
  beforeAll(async () => {
    ({ GET: getRoute } = await import('./route'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateTRPCContext.mockResolvedValue({ user: { id: USER_ID } });
    mockPersonalGetReviewConfig.mockResolvedValue({
      customInstructions: 'Follow the repository conventions.',
      modelSlug: null,
    });
    mockOrganizationGetReviewConfig.mockResolvedValue({
      customInstructions: 'Follow the repository conventions.',
      modelSlug: null,
    });
    mockPersonalListGitHubRepositories.mockResolvedValue(repositories);
    mockPersonalListGitLabRepositories.mockResolvedValue(repositories);
    mockOrganizationListGitHubRepositories.mockResolvedValue(repositories);
    mockOrganizationListGitLabRepositories.mockResolvedValue(repositories);
    mockPersonalPrepareSession.mockResolvedValue({ kiloSessionId: PERSONAL_KILO_SESSION_ID });
    mockOrganizationPrepareSession.mockResolvedValue({ kiloSessionId: ORG_KILO_SESSION_ID });
  });

  it('forces a provider read for the personal GitHub allowlist', async () => {
    const response = await getRoute(makeRequest({ platform: 'github', repo: 'owner/repo' }));

    // The allowlist must not answer from a synced (possibly empty) snapshot.
    expect(mockPersonalListGitHubRepositories).toHaveBeenCalledWith({ forceRefresh: true });
    expect(mockPersonalPrepareSession).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(303);
  });

  it('forces a provider read for the personal GitLab allowlist', async () => {
    const response = await getRoute(makeRequest({ platform: 'gitlab', repo: 'owner/repo' }));

    expect(mockPersonalListGitLabRepositories).toHaveBeenCalledWith({ forceRefresh: true });
    expect(mockPersonalPrepareSession).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(303);
  });

  it('forces a provider read for the organization GitHub allowlist', async () => {
    const response = await getRoute(
      makeRequest({ platform: 'github', repo: 'owner/repo', organizationId: ORG_ID })
    );

    expect(mockOrganizationListGitHubRepositories).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      forceRefresh: true,
    });
    expect(mockOrganizationPrepareSession).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(303);
  });

  it('forces a provider read for the organization GitLab allowlist', async () => {
    const response = await getRoute(
      makeRequest({ platform: 'gitlab', repo: 'owner/repo', organizationId: ORG_ID })
    );

    expect(mockOrganizationListGitLabRepositories).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      forceRefresh: true,
    });
    expect(mockOrganizationPrepareSession).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(303);
  });

  it('still rejects a repository the provider does not report', async () => {
    mockPersonalListGitHubRepositories.mockResolvedValue(syncedEmptyRepositories);

    const response = await getRoute(makeRequest({ platform: 'github', repo: 'owner/repo' }));

    expectErrorRedirect(response, 'repository_not_allowed');
    expect(mockPersonalPrepareSession).not.toHaveBeenCalled();
  });

  it('rejects a cross-site request before reading repositories', async () => {
    const response = await getRoute(
      makeRequest({ platform: 'github', repo: 'owner/repo', secFetchSite: 'cross-site' })
    );

    expectErrorRedirect(response, 'invalid_conversion_request');
    expect(mockPersonalListGitHubRepositories).not.toHaveBeenCalled();
  });
});

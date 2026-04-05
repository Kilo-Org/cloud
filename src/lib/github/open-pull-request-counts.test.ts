jest.mock('@/lib/config.server', () => ({
  GITHUB_ADMIN_STATS_TOKEN: 'test-token',
}));

jest.mock('@/lib/fetchWithBackoff', () => ({
  fetchWithBackoff: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(input, init),
}));

import { parseGithubListPullRequestsSummaryResponse } from '@/lib/github/open-pull-request-counts';

beforeEach(() => {
  // Reset the module registry so each test gets a fresh import with clean caches.
  jest.resetModules();
});

async function importModule() {
  return await import('@/lib/github/open-pull-request-counts');
}

function mockGithubJsonResponse(json: unknown): Response {
  return new Response(JSON.stringify(json), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Default org members response: empty org (all authors are external)
function emptyOrgMembersResponse(): Response {
  return mockGithubJsonResponse([]);
}

// Org members response with specified members
function orgMembersResponse(logins: string[]): Response {
  return mockGithubJsonResponse(logins.map(login => ({ login })));
}

describe('getKilocodeRepoOpenPullRequestsSummary bot author classification', () => {
  it('treats PRs authored by user.type === Bot as team PRs and excludes them from external list', async () => {
    const prListJson = parseGithubListPullRequestsSummaryResponse([
      {
        number: 1,
        title: 'bot pr',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/1',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 0,
        review_comments: 0,
        user: { login: 'renovate', type: 'Bot' },
      },
      {
        number: 2,
        title: 'external pr',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/2',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 1,
        review_comments: 2,
        user: { login: 'some-user', type: 'User' },
      },
    ]);

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (
          urlString.includes('/repos/Kilo-Org/kilocode/pulls') &&
          init?.method !== undefined &&
          init.method !== 'GET'
        ) {
          throw new Error('Unexpected non-GET request');
        }

        // List pulls endpoint includes query params (e.g. /pulls?state=open...)
        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls?')) {
          return mockGithubJsonResponse(prListJson);
        }

        // Bulk org members endpoint
        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return emptyOrgMembersResponse();
        }

        // Comment endpoints should be hit only for the external PR (number 2).
        if (urlString.includes('/issues/2/comments') || urlString.includes('/pulls/2/comments')) {
          return mockGithubJsonResponse([]);
        }

        if (urlString.includes('/pulls/2/reviews')) {
          return mockGithubJsonResponse([]);
        }

        if (urlString.includes('/issues/1/comments') || urlString.includes('/pulls/1/comments')) {
          throw new Error('Bot PR comment endpoints should not be queried');
        }

        throw new Error(`Unexpected fetch: ${urlString}`);
      });

    const { getKilocodeRepoOpenPullRequestsSummary } = await importModule();
    const summary = await getKilocodeRepoOpenPullRequestsSummary({
      ttlMs: 0,
      repos: ['kilocode'],
      commentConcurrency: 1,
      maxIssueCommentPages: 1,
      maxReviewCommentPages: 1,
    });

    expect(summary.totalOpenPullRequests).toBe(2);
    expect(summary.teamOpenPullRequests).toBe(1);
    expect(summary.externalOpenPullRequests).toBe(1);

    expect(summary.externalOpenPullRequestsList).toHaveLength(1);
    expect(summary.externalOpenPullRequestsList[0]?.authorLogin).toBe('some-user');
    expect(summary.externalOpenPullRequestsList[0]?.repo).toBe('kilocode');
    expect(summary.externalOpenPullRequestsList.some(pr => pr.authorLogin === 'renovate')).toBe(
      false
    );

    fetchMock.mockRestore();
  });

  it('does not compute teamCommented for bot-authored PRs', async () => {
    const prListJson = parseGithubListPullRequestsSummaryResponse([
      {
        number: 1,
        title: 'bot pr',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/1',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 0,
        review_comments: 0,
        user: { login: 'dependabot', type: 'Bot' },
      },
    ]);

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        // List pulls endpoint includes query params (e.g. /pulls?state=open...)
        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls?')) {
          return mockGithubJsonResponse(prListJson);
        }

        // Bulk org members endpoint
        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return emptyOrgMembersResponse();
        }

        if (
          urlString.includes('/issues/1/comments') ||
          urlString.includes('/pulls/1/comments') ||
          urlString.includes('/pulls/1/reviews')
        ) {
          throw new Error('No comment checks expected for bot-only PR list');
        }

        throw new Error(`Unexpected fetch: ${urlString}`);
      });

    const { getKilocodeRepoOpenPullRequestsSummary } = await importModule();
    const summary = await getKilocodeRepoOpenPullRequestsSummary({
      ttlMs: 0,
      repos: ['kilocode'],
      commentConcurrency: 1,
      maxIssueCommentPages: 1,
      maxReviewCommentPages: 1,
    });

    expect(summary.totalOpenPullRequests).toBe(1);
    expect(summary.teamOpenPullRequests).toBe(1);
    expect(summary.externalOpenPullRequests).toBe(0);
    expect(summary.externalOpenPullRequestsList).toHaveLength(0);

    fetchMock.mockRestore();
  });
});

describe('getKilocodeRepoRecentlyClosedExternalPRs', () => {
  it('classifies merged vs closed-unmerged, derives displayDate, and excludes bots + org members', async () => {
    const closedPrsJson = [
      {
        number: 1,
        title: 'Merged external PR',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/1',
        closed_at: '2024-01-02T00:00:00.000Z',
        merged_at: '2024-01-01T00:00:00.000Z',
        user: { login: 'external-user', type: 'User' },
      },
      {
        number: 2,
        title: 'Closed external PR',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/2',
        closed_at: '2024-01-03T00:00:00.000Z',
        merged_at: null,
        user: { login: 'external-user-2', type: 'User' },
      },
      {
        number: 3,
        title: 'Bot PR should be excluded',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/3',
        closed_at: '2024-01-04T00:00:00.000Z',
        merged_at: null,
        user: { login: 'renovate', type: 'Bot' },
      },
      {
        number: 4,
        title: 'Org member PR should be excluded',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/4',
        closed_at: '2024-01-05T00:00:00.000Z',
        merged_at: null,
        user: { login: 'kilo-team-member', type: 'User' },
      },
    ];

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (
          urlString.includes('/repos/Kilo-Org/kilocode/pulls?') &&
          urlString.includes('state=closed')
        ) {
          return mockGithubJsonResponse(closedPrsJson);
        }

        // Bulk org members endpoint — kilo-team-member is a member
        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return orgMembersResponse(['kilo-team-member']);
        }

        return new Response('', { status: 404, statusText: `Unexpected fetch: ${urlString}` });
      });

    const { getKilocodeRepoRecentlyClosedExternalPRs } = await importModule();
    const result = await getKilocodeRepoRecentlyClosedExternalPRs({
      ttlMs: 0,
      maxResults: 50,
      repos: ['kilocode'],
    });

    expect(result.prs.map(pr => pr.number)).toEqual([2, 1]);
    expect(result.prs[0]?.status).toBe('closed');
    expect(result.prs[0]?.displayDate).toBe('2024-01-03T00:00:00.000Z');
    expect(result.prs[0]?.repo).toBe('kilocode');
    expect(result.prs[1]?.status).toBe('merged');
    expect(result.prs[1]?.displayDate).toBe('2024-01-01T00:00:00.000Z');
    expect(result.prs[1]?.repo).toBe('kilocode');

    expect(typeof result.thisWeekMergedCount).toBe('number');
    expect(typeof result.thisWeekClosedCount).toBe('number');
    expect(typeof result.weekStart).toBe('string');

    fetchMock.mockRestore();
  });
});

describe('getKilocodeRepoOpenPullRequestsSummary draft filtering', () => {
  it('excludes draft PRs by default from counts and external list', async () => {
    const prListJson = parseGithubListPullRequestsSummaryResponse([
      {
        number: 1,
        title: 'draft external pr',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/1',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: true,
        comments: 0,
        review_comments: 0,
        user: { login: 'draft-user', type: 'User' },
      },
      {
        number: 2,
        title: 'ready external pr',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/2',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 1,
        review_comments: 2,
        user: { login: 'some-user', type: 'User' },
      },
      {
        number: 3,
        title: 'draft bot pr',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/3',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: true,
        comments: 0,
        review_comments: 0,
        user: { login: 'renovate', type: 'Bot' },
      },
    ]);

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls?')) {
          return mockGithubJsonResponse(prListJson);
        }

        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return emptyOrgMembersResponse();
        }

        if (urlString.includes('/issues/') || urlString.includes('/pulls/')) {
          return mockGithubJsonResponse([]);
        }

        throw new Error(`Unexpected fetch: ${urlString}`);
      });

    const { getKilocodeRepoOpenPullRequestsSummary } = await importModule();
    const summary = await getKilocodeRepoOpenPullRequestsSummary({
      ttlMs: 0,
      repos: ['kilocode'],
      commentConcurrency: 1,
      maxIssueCommentPages: 1,
      maxReviewCommentPages: 1,
    });

    // Only PR #2 should be considered.
    expect(summary.totalOpenPullRequests).toBe(1);
    expect(summary.teamOpenPullRequests).toBe(0);
    expect(summary.externalOpenPullRequests).toBe(1);
    expect(summary.externalOpenPullRequestsList).toHaveLength(1);
    expect(summary.externalOpenPullRequestsList[0]?.number).toBe(2);

    fetchMock.mockRestore();
  });

  it('includes draft PRs when includeDrafts=true', async () => {
    const prListJson = parseGithubListPullRequestsSummaryResponse([
      {
        number: 1,
        title: 'draft external pr',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/1',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: true,
        comments: 0,
        review_comments: 0,
        user: { login: 'draft-user', type: 'User' },
      },
      {
        number: 2,
        title: 'ready external pr',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/2',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 1,
        review_comments: 2,
        user: { login: 'some-user', type: 'User' },
      },
      {
        number: 3,
        title: 'draft bot pr',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/3',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: true,
        comments: 0,
        review_comments: 0,
        user: { login: 'renovate', type: 'Bot' },
      },
    ]);

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls?')) {
          return mockGithubJsonResponse(prListJson);
        }

        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return emptyOrgMembersResponse();
        }

        // Comment endpoints should be hit only for external PRs (1 and 2), not the bot PR.
        if (
          urlString.includes('/issues/1/comments') ||
          urlString.includes('/pulls/1/comments') ||
          urlString.includes('/issues/2/comments') ||
          urlString.includes('/pulls/2/comments')
        ) {
          return mockGithubJsonResponse([]);
        }

        if (urlString.includes('/pulls/1/reviews') || urlString.includes('/pulls/2/reviews')) {
          return mockGithubJsonResponse([]);
        }

        if (urlString.includes('/issues/3/comments') || urlString.includes('/pulls/3/comments')) {
          throw new Error('Bot PR comment endpoints should not be queried');
        }

        throw new Error(`Unexpected fetch: ${urlString}`);
      });

    const { getKilocodeRepoOpenPullRequestsSummary } = await importModule();
    const summary = await getKilocodeRepoOpenPullRequestsSummary({
      ttlMs: 0,
      includeDrafts: true,
      repos: ['kilocode'],
      commentConcurrency: 1,
      maxIssueCommentPages: 1,
      maxReviewCommentPages: 1,
    });

    expect(summary.totalOpenPullRequests).toBe(3);
    expect(summary.teamOpenPullRequests).toBe(1);
    expect(summary.externalOpenPullRequests).toBe(2);
    expect(summary.externalOpenPullRequestsList.map(pr => pr.number).sort((a, b) => a - b)).toEqual(
      [1, 2]
    );

    fetchMock.mockRestore();
  });
});

describe('getKilocodeRepoOpenPullRequestsSummary team approval classification', () => {
  it('treats PRs with a team APPROVED review as teamCommented even when there are zero comments', async () => {
    const prListJson = parseGithubListPullRequestsSummaryResponse([
      {
        number: 10,
        title: 'external pr needing approval signal',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/10',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 0,
        review_comments: 0,
        user: { login: 'external-user', type: 'User' },
      },
    ]);

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls/10/reviews')) {
          return mockGithubJsonResponse([
            { state: 'APPROVED', user: { login: 'kilo-team-member' } },
          ]);
        }

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls?')) {
          return mockGithubJsonResponse(prListJson);
        }

        // Bulk org members — kilo-team-member is in the org
        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return orgMembersResponse(['kilo-team-member']);
        }

        if (urlString.includes('/issues/10/comments') || urlString.includes('/pulls/10/comments')) {
          return mockGithubJsonResponse([]);
        }

        return new Response('', { status: 404, statusText: `Unexpected fetch: ${urlString}` });
      });

    const { getKilocodeRepoOpenPullRequestsSummary } = await importModule();
    const summary = await getKilocodeRepoOpenPullRequestsSummary({
      ttlMs: 0,
      repos: ['kilocode'],
      commentConcurrency: 1,
      maxIssueCommentPages: 1,
      maxReviewCommentPages: 1,
      maxPullRequestReviewPages: 1,
    });

    expect(summary.externalOpenPullRequestsList).toHaveLength(1);
    expect(summary.externalOpenPullRequestsList[0]?.number).toBe(10);
    expect(summary.externalOpenPullRequestsList[0]?.teamCommented).toBe(true);

    fetchMock.mockRestore();
  });

  it('treats PRs with a team COMMENTED review as teamCommented even when there are zero comments', async () => {
    const prListJson = parseGithubListPullRequestsSummaryResponse([
      {
        number: 11,
        title: 'external pr needing reviewed signal',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/11',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 0,
        review_comments: 0,
        user: { login: 'external-user', type: 'User' },
      },
    ]);

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls/11/reviews')) {
          return mockGithubJsonResponse([
            { state: 'COMMENTED', user: { login: 'kilo-team-member' } },
          ]);
        }

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls?')) {
          return mockGithubJsonResponse(prListJson);
        }

        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return orgMembersResponse(['kilo-team-member']);
        }

        if (urlString.includes('/issues/11/comments')) {
          return mockGithubJsonResponse([]);
        }

        // Review comments should not be queried because team-reviewed already short-circuits.
        if (urlString.includes('/pulls/11/comments')) {
          throw new Error(
            'Review comments should not be queried when a team review already exists'
          );
        }

        return new Response('', { status: 404, statusText: `Unexpected fetch: ${urlString}` });
      });

    const { getKilocodeRepoOpenPullRequestsSummary } = await importModule();
    const summary = await getKilocodeRepoOpenPullRequestsSummary({
      ttlMs: 0,
      repos: ['kilocode'],
      commentConcurrency: 1,
      maxIssueCommentPages: 1,
      maxReviewCommentPages: 1,
      maxPullRequestReviewPages: 1,
    });

    expect(summary.externalOpenPullRequestsList).toHaveLength(1);
    expect(summary.externalOpenPullRequestsList[0]?.number).toBe(11);
    expect(summary.externalOpenPullRequestsList[0]?.teamCommented).toBe(true);

    fetchMock.mockRestore();
  });

  it('treats PRs with a team CHANGES_REQUESTED review as teamCommented even when there are zero comments', async () => {
    const prListJson = parseGithubListPullRequestsSummaryResponse([
      {
        number: 12,
        title: 'external pr needing changes requested signal',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/12',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 0,
        review_comments: 0,
        user: { login: 'external-user', type: 'User' },
      },
    ]);

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls/12/reviews')) {
          return mockGithubJsonResponse([
            { state: 'CHANGES_REQUESTED', user: { login: 'kilo-team-member' } },
          ]);
        }

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls?')) {
          return mockGithubJsonResponse(prListJson);
        }

        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return orgMembersResponse(['kilo-team-member']);
        }

        if (urlString.includes('/issues/12/comments')) {
          return mockGithubJsonResponse([]);
        }

        // Review comments should not be queried because team-reviewed already short-circuits.
        if (urlString.includes('/pulls/12/comments')) {
          throw new Error(
            'Review comments should not be queried when a team review already exists'
          );
        }

        return new Response('', { status: 404, statusText: `Unexpected fetch: ${urlString}` });
      });

    const { getKilocodeRepoOpenPullRequestsSummary } = await importModule();
    const summary = await getKilocodeRepoOpenPullRequestsSummary({
      ttlMs: 0,
      repos: ['kilocode'],
      commentConcurrency: 1,
      maxIssueCommentPages: 1,
      maxReviewCommentPages: 1,
      maxPullRequestReviewPages: 1,
    });

    expect(summary.externalOpenPullRequestsList).toHaveLength(1);
    expect(summary.externalOpenPullRequestsList[0]?.number).toBe(12);
    expect(summary.externalOpenPullRequestsList[0]?.teamCommented).toBe(true);

    fetchMock.mockRestore();
  });

  it('treats PRs with a team inline review comment as teamCommented even when there are zero issue comments and no reviews', async () => {
    const prListJson = parseGithubListPullRequestsSummaryResponse([
      {
        number: 13,
        title: 'external pr needing inline review comment signal',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/13',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 0,
        review_comments: 1,
        user: { login: 'external-user', type: 'User' },
      },
    ]);

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls/13/reviews')) {
          return mockGithubJsonResponse([]);
        }

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls?')) {
          return mockGithubJsonResponse(prListJson);
        }

        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return orgMembersResponse(['kilo-team-member']);
        }

        if (urlString.includes('/issues/13/comments')) {
          return mockGithubJsonResponse([]);
        }

        if (urlString.includes('/pulls/13/comments')) {
          return mockGithubJsonResponse([{ user: { login: 'kilo-team-member' } }]);
        }

        return new Response('', { status: 404, statusText: `Unexpected fetch: ${urlString}` });
      });

    const { getKilocodeRepoOpenPullRequestsSummary } = await importModule();
    const summary = await getKilocodeRepoOpenPullRequestsSummary({
      ttlMs: 0,
      repos: ['kilocode'],
      commentConcurrency: 1,
      maxIssueCommentPages: 1,
      maxReviewCommentPages: 1,
      maxPullRequestReviewPages: 1,
    });

    expect(summary.externalOpenPullRequestsList).toHaveLength(1);
    expect(summary.externalOpenPullRequestsList[0]?.number).toBe(13);
    expect(summary.externalOpenPullRequestsList[0]?.teamCommented).toBe(true);

    fetchMock.mockRestore();
  });

  it('does not treat external-only reviews/comments as teamCommented', async () => {
    const prListJson = parseGithubListPullRequestsSummaryResponse([
      {
        number: 14,
        title: 'external pr with external-only interaction',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/14',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 0,
        review_comments: 1,
        user: { login: 'external-user', type: 'User' },
      },
    ]);

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls/14/reviews')) {
          return mockGithubJsonResponse([
            { state: 'COMMENTED', user: { login: 'external-reviewer' } },
          ]);
        }

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls?')) {
          return mockGithubJsonResponse(prListJson);
        }

        // No org members
        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return emptyOrgMembersResponse();
        }

        if (urlString.includes('/issues/14/comments')) {
          return mockGithubJsonResponse([]);
        }

        if (urlString.includes('/pulls/14/comments')) {
          return mockGithubJsonResponse([{ user: { login: 'external-reviewer' } }]);
        }

        return new Response('', { status: 404, statusText: `Unexpected fetch: ${urlString}` });
      });

    const { getKilocodeRepoOpenPullRequestsSummary } = await importModule();
    const summary = await getKilocodeRepoOpenPullRequestsSummary({
      ttlMs: 0,
      repos: ['kilocode'],
      commentConcurrency: 1,
      maxIssueCommentPages: 1,
      maxReviewCommentPages: 1,
      maxPullRequestReviewPages: 1,
    });

    expect(summary.externalOpenPullRequestsList).toHaveLength(1);
    expect(summary.externalOpenPullRequestsList[0]?.number).toBe(14);
    expect(summary.externalOpenPullRequestsList[0]?.teamCommented).toBe(false);

    fetchMock.mockRestore();
  });

  it('computes reviewStatus with precedence and ignores external-only approvals', async () => {
    const prListJson = parseGithubListPullRequestsSummaryResponse([
      {
        number: 20,
        title: 'external pr with mixed reviews',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/20',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 0,
        review_comments: 0,
        user: { login: 'external-user', type: 'User' },
      },
      {
        number: 21,
        title: 'external pr approved by external only',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/21',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 0,
        review_comments: 0,
        user: { login: 'external-user', type: 'User' },
      },
    ]);

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls?')) {
          return mockGithubJsonResponse(prListJson);
        }

        // kilo-team-member is in the org
        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return orgMembersResponse(['kilo-team-member']);
        }

        // PR #20: same reviewer submits multiple reviews; latest wins.
        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls/20/reviews')) {
          return mockGithubJsonResponse([
            { state: 'APPROVED', user: { login: 'external-reviewer' } },
            { state: 'COMMENTED', user: { login: 'external-reviewer' } },
            { state: 'CHANGES_REQUESTED', user: { login: 'external-reviewer' } },
            { state: 'APPROVED', user: { login: 'kilo-team-member' } },
          ]);
        }

        // PR #21: only external approval; should NOT be considered approved.
        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls/21/reviews')) {
          return mockGithubJsonResponse([
            { state: 'APPROVED', user: { login: 'external-reviewer' } },
          ]);
        }

        if (urlString.includes('/issues/20/comments') || urlString.includes('/pulls/20/comments')) {
          return mockGithubJsonResponse([]);
        }
        if (urlString.includes('/issues/21/comments') || urlString.includes('/pulls/21/comments')) {
          return mockGithubJsonResponse([]);
        }

        return new Response('', { status: 404, statusText: `Unexpected fetch: ${urlString}` });
      });

    const { getKilocodeRepoOpenPullRequestsSummary } = await importModule();
    const summary = await getKilocodeRepoOpenPullRequestsSummary({
      ttlMs: 0,
      repos: ['kilocode'],
      commentConcurrency: 1,
      maxIssueCommentPages: 1,
      maxReviewCommentPages: 1,
      maxPullRequestReviewPages: 1,
    });

    const pr20 = summary.externalOpenPullRequestsList.find(pr => pr.number === 20);
    const pr21 = summary.externalOpenPullRequestsList.find(pr => pr.number === 21);

    expect(pr20?.reviewStatus).toBe('changes_requested');
    expect(pr21?.reviewStatus).toBe('no_reviews');

    fetchMock.mockRestore();
  });
});

describe('multi-repo aggregation', () => {
  it('aggregates open PR counts and lists across repos with correct repo field', async () => {
    const kilocodePrs = parseGithubListPullRequestsSummaryResponse([
      {
        number: 1,
        title: 'kilocode pr',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/1',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 0,
        review_comments: 0,
        user: { login: 'external-a', type: 'User' },
      },
    ]);

    const cloudPrs = parseGithubListPullRequestsSummaryResponse([
      {
        number: 10,
        title: 'cloud pr',
        html_url: 'https://github.com/Kilo-Org/cloud/pull/10',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 0,
        review_comments: 0,
        user: { login: 'external-b', type: 'User' },
      },
      {
        number: 11,
        title: 'cloud team pr',
        html_url: 'https://github.com/Kilo-Org/cloud/pull/11',
        created_at: '2020-01-01T00:00:00.000Z',
        draft: false,
        comments: 0,
        review_comments: 0,
        user: { login: 'kilo-member', type: 'User' },
      },
    ]);

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (urlString.includes('/repos/Kilo-Org/kilocode/pulls?')) {
          return mockGithubJsonResponse(kilocodePrs);
        }
        if (urlString.includes('/repos/Kilo-Org/cloud/pulls?')) {
          return mockGithubJsonResponse(cloudPrs);
        }

        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return orgMembersResponse(['kilo-member']);
        }

        if (urlString.includes('/issues/') || urlString.includes('/pulls/')) {
          return mockGithubJsonResponse([]);
        }

        throw new Error(`Unexpected fetch: ${urlString}`);
      });

    const { getKilocodeRepoOpenPullRequestsSummary } = await importModule();
    const summary = await getKilocodeRepoOpenPullRequestsSummary({
      ttlMs: 0,
      repos: ['kilocode', 'cloud'],
      commentConcurrency: 1,
      maxIssueCommentPages: 1,
      maxReviewCommentPages: 1,
    });

    expect(summary.totalOpenPullRequests).toBe(3);
    expect(summary.teamOpenPullRequests).toBe(1);
    expect(summary.externalOpenPullRequests).toBe(2);
    expect(summary.externalOpenPullRequestsList).toHaveLength(2);

    const pr1 = summary.externalOpenPullRequestsList.find(pr => pr.number === 1);
    const pr10 = summary.externalOpenPullRequestsList.find(pr => pr.number === 10);
    expect(pr1?.repo).toBe('kilocode');
    expect(pr10?.repo).toBe('cloud');

    fetchMock.mockRestore();
  });

  it('merges closed PRs across repos sorted by displayDate and trims to maxResults', async () => {
    const kilocodeClosedPrs = [
      {
        number: 1,
        title: 'oldest merged',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/1',
        closed_at: '2024-01-01T00:00:00.000Z',
        merged_at: '2024-01-01T00:00:00.000Z',
        user: { login: 'external-a', type: 'User' },
      },
      {
        number: 2,
        title: 'newest closed',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/2',
        closed_at: '2024-01-10T00:00:00.000Z',
        merged_at: null,
        user: { login: 'external-b', type: 'User' },
      },
    ];

    const cloudClosedPrs = [
      {
        number: 20,
        title: 'middle merged',
        html_url: 'https://github.com/Kilo-Org/cloud/pull/20',
        closed_at: '2024-01-06T00:00:00.000Z',
        merged_at: '2024-01-05T00:00:00.000Z',
        user: { login: 'external-c', type: 'User' },
      },
    ];

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (
          urlString.includes('/repos/Kilo-Org/kilocode/pulls?') &&
          urlString.includes('state=closed')
        ) {
          return mockGithubJsonResponse(kilocodeClosedPrs);
        }
        if (
          urlString.includes('/repos/Kilo-Org/cloud/pulls?') &&
          urlString.includes('state=closed')
        ) {
          return mockGithubJsonResponse(cloudClosedPrs);
        }

        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return emptyOrgMembersResponse();
        }

        return new Response('', { status: 404, statusText: `Unexpected fetch: ${urlString}` });
      });

    const { getKilocodeRepoRecentlyClosedExternalPRs } = await importModule();

    // maxResults=2 should trim to 2 after cross-repo sort
    const result = await getKilocodeRepoRecentlyClosedExternalPRs({
      ttlMs: 0,
      maxResults: 2,
      repos: ['kilocode', 'cloud'],
    });

    expect(result.prs).toHaveLength(2);
    // Sorted by displayDate desc: PR #2 (Jan 10), PR #20 (Jan 5 merged_at)
    expect(result.prs[0]?.number).toBe(2);
    expect(result.prs[0]?.repo).toBe('kilocode');
    expect(result.prs[1]?.number).toBe(20);
    expect(result.prs[1]?.repo).toBe('cloud');

    fetchMock.mockRestore();
  });

  it('aggregates week stats across repos', async () => {
    // Use a fixed "now" in the middle of a known week (Mon Jan 15 2024)
    const now = new Date('2024-01-17T12:00:00.000Z');

    const kilocodeClosedPrs = [
      {
        number: 1,
        title: 'merged this week',
        html_url: 'https://github.com/Kilo-Org/kilocode/pull/1',
        closed_at: '2024-01-16T00:00:00.000Z',
        merged_at: '2024-01-16T00:00:00.000Z',
        user: { login: 'external-a', type: 'User' },
      },
    ];

    const cloudClosedPrs = [
      {
        number: 20,
        title: 'also merged this week',
        html_url: 'https://github.com/Kilo-Org/cloud/pull/20',
        closed_at: '2024-01-17T00:00:00.000Z',
        merged_at: '2024-01-17T00:00:00.000Z',
        user: { login: 'external-b', type: 'User' },
      },
      {
        number: 21,
        title: 'closed unmerged this week',
        html_url: 'https://github.com/Kilo-Org/cloud/pull/21',
        closed_at: '2024-01-15T00:00:00.000Z',
        merged_at: null,
        user: { login: 'external-c', type: 'User' },
      },
    ];

    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (
          urlString.includes('/repos/Kilo-Org/kilocode/pulls?') &&
          urlString.includes('state=closed')
        ) {
          return mockGithubJsonResponse(kilocodeClosedPrs);
        }
        if (
          urlString.includes('/repos/Kilo-Org/cloud/pulls?') &&
          urlString.includes('state=closed')
        ) {
          return mockGithubJsonResponse(cloudClosedPrs);
        }

        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return emptyOrgMembersResponse();
        }

        return new Response('', { status: 404, statusText: `Unexpected fetch: ${urlString}` });
      });

    const { getKilocodeRepoRecentlyClosedExternalPRs } = await importModule();
    const result = await getKilocodeRepoRecentlyClosedExternalPRs({
      ttlMs: 0,
      maxResults: 50,
      repos: ['kilocode', 'cloud'],
      now,
      timeZone: 'UTC',
    });

    // 1 merged from kilocode + 1 merged from cloud = 2
    expect(result.thisWeekMergedCount).toBe(2);
    // 1 closed-unmerged from cloud
    expect(result.thisWeekClosedCount).toBe(1);
    expect(result.prs).toHaveLength(3);

    fetchMock.mockRestore();
  });

  it('defaults to all repos when repos param is omitted', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL) => {
        const urlString = typeof input === 'string' ? input : input.toString();

        if (urlString.includes('/pulls?')) {
          return mockGithubJsonResponse([]);
        }

        if (urlString.includes('/orgs/Kilo-Org/members')) {
          return emptyOrgMembersResponse();
        }

        return new Response('', { status: 404, statusText: `Unexpected fetch: ${urlString}` });
      });

    const { getKilocodeRepoOpenPullRequestsSummary } = await importModule();
    await getKilocodeRepoOpenPullRequestsSummary({ ttlMs: 0 });

    const pullsCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === 'string' ? input : input.toString();
      return url.includes('/pulls?');
    });

    const repos = pullsCalls.map(([input]) => {
      const url = typeof input === 'string' ? input : input.toString();
      const match = url.match(/repos\/Kilo-Org\/([^/]+)\/pulls/);
      return match?.[1];
    });

    expect(repos).toContain('kilocode');
    expect(repos).toContain('cloud');
    expect(repos).toContain('kilo-marketplace');
    expect(repos).toContain('kilocode-legacy');

    fetchMock.mockRestore();
  });
});

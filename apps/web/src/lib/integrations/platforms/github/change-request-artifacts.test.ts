/**
 * Tests for the change-request artifact helpers in `adapter.ts`.
 *
 * The adapter module is globally mocked via Jest config when imported through
 * the `@/` alias, so these tests import via a relative path and mock Octokit.
 */

process.env.GITHUB_APP_ID = 'test-app-id';
process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';
process.env.GITHUB_LITE_APP_ID = 'test-lite-app-id';
process.env.GITHUB_LITE_APP_PRIVATE_KEY = 'test-lite-private-key';

const mockGetContent = jest.fn();
const mockCreateOrUpdateFileContents = jest.fn();
const mockGetRef = jest.fn();
const mockCreateRef = jest.fn();
const mockCreatePull = jest.fn();
const mockListPulls = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    repos: {
      getContent: mockGetContent,
      createOrUpdateFileContents: mockCreateOrUpdateFileContents,
    },
    git: { getRef: mockGetRef, createRef: mockCreateRef },
    pulls: { create: mockCreatePull, list: mockListPulls },
  })),
}));

import {
  createGitHubBranch,
  createGitHubPullRequest,
  createOrUpdateGitHubRootTextFile,
  fetchGitHubPullRequestForHeadBranch,
} from './adapter';

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

beforeEach(() => {
  mockGetContent.mockReset();
  mockCreateOrUpdateFileContents.mockReset();
  mockGetRef.mockReset();
  mockCreateRef.mockReset();
  mockCreatePull.mockReset();
  mockListPulls.mockReset();
});

describe('createGitHubBranch', () => {
  const params = {
    token: 'mock-token',
    owner: 'acme',
    repo: 'widgets',
    branchName: 'review/fix-1',
    baseBranch: 'main',
  };

  it('sends the deadline signal when reading the base ref and creating the branch', async () => {
    mockGetRef.mockResolvedValueOnce({ data: { object: { sha: 'a'.repeat(40) } } });
    mockCreateRef.mockResolvedValueOnce({ data: {} });

    await expect(createGitHubBranch(params)).resolves.toBeUndefined();

    expect(mockGetRef).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      ref: 'heads/main',
      request: { signal: expect.any(AbortSignal) },
    });
    expect(mockCreateRef).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      ref: 'refs/heads/review/fix-1',
      sha: 'a'.repeat(40),
      request: { signal: expect.any(AbortSignal) },
    });
  });

  it('tolerates a 422 reference-already-exists response', async () => {
    mockGetRef.mockResolvedValueOnce({ data: { object: { sha: 'b'.repeat(40) } } });
    mockCreateRef.mockRejectedValueOnce(httpError(422, 'Reference already exists'));

    await expect(createGitHubBranch(params)).resolves.toBeUndefined();
    expect(mockCreateRef).toHaveBeenCalledTimes(1);
  });
});

describe('createOrUpdateGitHubRootTextFile', () => {
  const params = {
    token: 'mock-token',
    owner: 'acme',
    repo: 'widgets',
    path: 'REVIEW.md',
    branch: 'review/fix-1',
    message: 'Update review policy',
    content: '# Review policy\nFlag only regressions.',
  };

  it('commits with the existing sha when the file content differs', async () => {
    mockGetContent.mockResolvedValueOnce({
      data: { type: 'file', encoding: 'base64', sha: 'sha-1', content: 'b2xkIGNvbnRlbnQ=' },
    });
    mockCreateOrUpdateFileContents.mockResolvedValueOnce({ data: {} });

    await expect(createOrUpdateGitHubRootTextFile(params)).resolves.toBeUndefined();

    expect(mockGetContent).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      path: 'REVIEW.md',
      ref: 'review/fix-1',
      request: { signal: expect.any(AbortSignal) },
    });
    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      path: 'REVIEW.md',
      branch: 'review/fix-1',
      message: 'Update review policy',
      content: Buffer.from(params.content, 'utf8').toString('base64'),
      sha: 'sha-1',
      request: { signal: expect.any(AbortSignal) },
    });
  });

  it('makes no commit when the decoded file content already equals the wanted content', async () => {
    mockGetContent.mockResolvedValueOnce({
      data: {
        type: 'file',
        encoding: 'base64',
        sha: 'sha-1',
        content: Buffer.from(params.content, 'utf8').toString('base64'),
      },
    });

    await expect(createOrUpdateGitHubRootTextFile(params)).resolves.toBeUndefined();

    expect(mockGetContent).toHaveBeenCalledTimes(1);
    expect(mockCreateOrUpdateFileContents).not.toHaveBeenCalled();
  });

  it('creates the file when the read returns 404', async () => {
    mockGetContent.mockRejectedValueOnce(httpError(404, 'Not Found'));
    mockCreateOrUpdateFileContents.mockResolvedValueOnce({ data: {} });

    await expect(createOrUpdateGitHubRootTextFile(params)).resolves.toBeUndefined();

    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      path: 'REVIEW.md',
      branch: 'review/fix-1',
      message: 'Update review policy',
      content: Buffer.from(params.content, 'utf8').toString('base64'),
      request: { signal: expect.any(AbortSignal) },
    });
  });
});

describe('createGitHubPullRequest', () => {
  it('sends the deadline signal when opening the pull request', async () => {
    mockCreatePull.mockResolvedValueOnce({ data: { number: 7, html_url: 'pr-url' } });

    await expect(
      createGitHubPullRequest({
        token: 'mock-token',
        owner: 'acme',
        repo: 'widgets',
        title: 'Fix review pipeline',
        body: 'Automated fix',
        headBranch: 'review/fix-1',
        baseBranch: 'main',
      })
    ).resolves.toEqual({ number: 7, url: 'pr-url' });

    expect(mockCreatePull).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      title: 'Fix review pipeline',
      body: 'Automated fix',
      head: 'review/fix-1',
      base: 'main',
      request: { signal: expect.any(AbortSignal) },
    });
  });
});

describe('fetchGitHubPullRequestForHeadBranch', () => {
  it('prefers an open pull over a newer closed one and filters server-side on head', async () => {
    mockListPulls.mockResolvedValueOnce({
      data: [
        {
          number: 42,
          state: 'closed',
          html_url: 'https://github.com/acme/widgets/pull/42',
          head: { ref: 'review/fix-1' },
        },
        {
          number: 7,
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/7',
          head: { ref: 'review/fix-1' },
        },
        {
          number: 9,
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/9',
          head: { ref: 'other-branch' },
        },
      ],
    });

    await expect(
      fetchGitHubPullRequestForHeadBranch({
        token: 'mock-token',
        owner: 'acme',
        repo: 'widgets',
        headBranch: 'review/fix-1',
      })
    ).resolves.toEqual({ number: 7, url: 'https://github.com/acme/widgets/pull/7' });

    expect(mockListPulls).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      state: 'all',
      head: 'acme:review/fix-1',
      per_page: 100,
      request: { signal: expect.any(AbortSignal) },
    });
  });

  it('returns null when no pull matches the head branch', async () => {
    mockListPulls.mockResolvedValueOnce({ data: [] });

    await expect(
      fetchGitHubPullRequestForHeadBranch({
        token: 'mock-token',
        owner: 'acme',
        repo: 'widgets',
        headBranch: 'review/fix-1',
      })
    ).resolves.toBeNull();
  });
});

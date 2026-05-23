/**
 * Tests for repository content helpers in `adapter.ts`.
 *
 * The adapter module is globally mocked via Jest config when imported through
 * the `@/` alias, so these tests import via a relative path and mock Octokit.
 */

process.env.GITHUB_APP_ID = 'test-app-id';
process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';
process.env.GITHUB_LITE_APP_ID = 'test-lite-app-id';
process.env.GITHUB_LITE_APP_PRIVATE_KEY = 'test-lite-private-key';

const mockGetContent = jest.fn();
const mockRepoGet = jest.fn();
const mockCreateOrUpdateFileContents = jest.fn();
const mockGetRef = jest.fn();
const mockCreateRef = jest.fn();
const mockPullCreate = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    repos: {
      get: mockRepoGet,
      getContent: mockGetContent,
      createOrUpdateFileContents: mockCreateOrUpdateFileContents,
    },
    git: { getRef: mockGetRef, createRef: mockCreateRef },
    pulls: { create: mockPullCreate },
  })),
}));

import {
  createGitHubBranch,
  createGitHubPullRequest,
  createOrUpdateGitHubRootTextFile,
  decodeGitHubBase64Content,
  fetchGitHubRepositoryDefaultBranch,
  fetchGitHubRootTextFileAtRef,
} from './adapter';

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

beforeEach(() => {
  mockGetContent.mockReset();
  mockRepoGet.mockReset();
  mockCreateOrUpdateFileContents.mockReset();
  mockGetRef.mockReset();
  mockCreateRef.mockReset();
  mockPullCreate.mockReset();
});

describe('decodeGitHubBase64Content', () => {
  it('decodes base64 content with GitHub line wrapping', () => {
    const encoded = Buffer.from('# Review policy\nFlag only regressions.').toString('base64');

    expect(decodeGitHubBase64Content(`${encoded.slice(0, 12)}\n${encoded.slice(12)}`)).toBe(
      '# Review policy\nFlag only regressions.'
    );
  });
});

describe('fetchGitHubRootTextFileAtRef', () => {
  const params = {
    token: 'mock-token',
    owner: 'acme',
    repo: 'widgets',
    path: 'REVIEW.md',
    ref: 'main',
  };

  it('fetches and decodes a root text file at the requested ref', async () => {
    mockGetContent.mockResolvedValueOnce({
      data: {
        type: 'file',
        encoding: 'base64',
        content: Buffer.from('# Review policy\nFlag only regressions.').toString('base64'),
      },
    });

    const result = await fetchGitHubRootTextFileAtRef(params);

    expect(result).toBe('# Review policy\nFlag only regressions.');
    expect(mockGetContent).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      path: 'REVIEW.md',
      ref: 'main',
    });
  });

  it('returns null for 404 responses', async () => {
    mockGetContent.mockRejectedValueOnce(httpError(404));

    await expect(fetchGitHubRootTextFileAtRef(params)).resolves.toBeNull();
  });

  it('returns null for directory responses', async () => {
    mockGetContent.mockResolvedValueOnce({ data: [] });

    await expect(fetchGitHubRootTextFileAtRef(params)).resolves.toBeNull();
  });

  it('returns null for unsupported non-base64 file responses', async () => {
    mockGetContent.mockResolvedValueOnce({
      data: {
        type: 'file',
        encoding: 'none',
        content: 'plain text',
      },
    });

    await expect(fetchGitHubRootTextFileAtRef(params)).resolves.toBeNull();
  });

  it('throws non-404 API failures', async () => {
    const error = httpError(500);
    mockGetContent.mockRejectedValueOnce(error);

    await expect(fetchGitHubRootTextFileAtRef(params)).rejects.toBe(error);
  });
});

describe('Review Memory GitHub write helpers', () => {
  it('fetches the repository default branch', async () => {
    mockRepoGet.mockResolvedValueOnce({ data: { default_branch: 'main' } });

    await expect(
      fetchGitHubRepositoryDefaultBranch({ token: 'mock-token', owner: 'acme', repo: 'widgets' })
    ).resolves.toBe('main');
    expect(mockRepoGet).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets' });
  });

  it('creates a branch from the base branch ref', async () => {
    mockGetRef.mockResolvedValueOnce({ data: { object: { sha: 'base-sha' } } });
    mockCreateRef.mockResolvedValueOnce({});

    await createGitHubBranch({
      token: 'mock-token',
      owner: 'acme',
      repo: 'widgets',
      branchName: 'kilo/review-memory/abc123',
      baseBranch: 'main',
    });

    expect(mockGetRef).toHaveBeenCalledWith({ owner: 'acme', repo: 'widgets', ref: 'heads/main' });
    expect(mockCreateRef).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      ref: 'refs/heads/kilo/review-memory/abc123',
      sha: 'base-sha',
    });
  });

  it('updates an existing root text file on a branch', async () => {
    mockGetContent.mockResolvedValueOnce({ data: { type: 'file', sha: 'file-sha' } });
    mockCreateOrUpdateFileContents.mockResolvedValueOnce({});

    await createOrUpdateGitHubRootTextFile({
      token: 'mock-token',
      owner: 'acme',
      repo: 'widgets',
      path: 'REVIEW.md',
      branch: 'kilo/review-memory/abc123',
      message: 'docs(review): update REVIEW.md guidance',
      content: '## Review memory\n',
    });

    expect(mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'acme',
        repo: 'widgets',
        path: 'REVIEW.md',
        branch: 'kilo/review-memory/abc123',
        sha: 'file-sha',
        content: Buffer.from('## Review memory\n', 'utf8').toString('base64'),
      })
    );
  });

  it('opens a pull request', async () => {
    mockPullCreate.mockResolvedValueOnce({
      data: { number: 12, html_url: 'https://github.com/acme/widgets/pull/12' },
    });

    await expect(
      createGitHubPullRequest({
        token: 'mock-token',
        owner: 'acme',
        repo: 'widgets',
        title: 'docs(review): update REVIEW.md guidance',
        body: 'body',
        headBranch: 'kilo/review-memory/abc123',
        baseBranch: 'main',
      })
    ).resolves.toEqual({ number: 12, url: 'https://github.com/acme/widgets/pull/12' });
  });
});

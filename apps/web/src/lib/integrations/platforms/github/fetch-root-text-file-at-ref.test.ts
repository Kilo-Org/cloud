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

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    repos: { getContent: mockGetContent },
  })),
}));

import { decodeGitHubBase64Content, fetchGitHubRootTextFileAtRef } from './adapter';

function httpError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

beforeEach(() => {
  mockGetContent.mockReset();
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

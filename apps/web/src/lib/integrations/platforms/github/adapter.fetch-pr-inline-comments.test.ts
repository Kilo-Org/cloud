/**
 * The GitHub adapter is globally mocked through the `@/` alias in Jest config.
 * Import the relative module path here so this test exercises the real adapter.
 */

process.env.GITHUB_APP_ID = 'test-app-id';
process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';
process.env.GITHUB_LITE_APP_ID = 'test-lite-app-id';
process.env.GITHUB_LITE_APP_PRIVATE_KEY = 'test-lite-private-key';

const mockListReviewComments = jest.fn();

jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(async () => undefined),
}));

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    pulls: { listReviewComments: mockListReviewComments },
  })),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(() => async () => ({ token: 'mock-token', expiresAt: '2099-01-01' })),
}));

import { fetchPRInlineComments } from './adapter';

const PER_PAGE = 100;
const MAX_PAGES = 5;

function fullPage(page: number) {
  return {
    data: Array.from({ length: PER_PAGE }, (_, index) => ({
      id: page * PER_PAGE + index + 1,
      path: 'src/file.ts',
      line: index + 1,
      body: 'ordinary inline comment',
      position: index,
      user: { login: 'reviewer' },
    })),
  };
}

beforeEach(() => {
  mockListReviewComments.mockReset();
});

describe('fetchPRInlineComments', () => {
  it('returns comments from a single short page without a truncation marker', async () => {
    mockListReviewComments.mockResolvedValueOnce({
      data: Array.from({ length: 2 }, (_, index) => ({
        id: index + 1,
        path: 'src/file.ts',
        line: index + 1,
        body: 'short comment',
        position: index,
        user: { login: 'reviewer' },
      })),
    });

    const comments = await fetchPRInlineComments('42', 'acme', 'widgets', 7);

    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      id: 1,
      path: 'src/file.ts',
      line: 1,
      body: 'short comment',
      isOutdated: false,
      user: { login: 'reviewer' },
    });
    expect(mockListReviewComments).toHaveBeenCalledTimes(1);
  });

  it('marks comments with a null position as outdated', async () => {
    mockListReviewComments.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          path: 'src/file.ts',
          line: null,
          body: 'outdated comment',
          position: null,
          user: { login: 'reviewer' },
        },
      ],
    });

    const comments = await fetchPRInlineComments('42', 'acme', 'widgets', 7);

    expect(comments[0].isOutdated).toBe(true);
    expect(comments[0].line).toBeNull();
  });

  it('stops after the maximum page count when the provider always returns full pages', async () => {
    mockListReviewComments.mockImplementation(async ({ page }: { page: number }) => fullPage(page));

    const comments = await fetchPRInlineComments('42', 'acme', 'widgets', 7);

    expect(comments).toHaveLength(MAX_PAGES * PER_PAGE);
    expect(mockListReviewComments).toHaveBeenCalledTimes(MAX_PAGES);
    expect(mockListReviewComments).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: MAX_PAGES })
    );
  });

  it('truncates each stored body to the rendered length', async () => {
    const longBody = 'x'.repeat(500) + '\nsecond line';
    mockListReviewComments.mockResolvedValueOnce({
      data: [
        {
          id: 1,
          path: 'src/file.ts',
          line: 1,
          body: longBody,
          position: 0,
          user: { login: 'reviewer' },
        },
      ],
    });

    const comments = await fetchPRInlineComments('42', 'acme', 'widgets', 7);

    expect(comments[0].body).toBe('x'.repeat(60));
    expect(comments[0].body.length).toBeLessThanOrEqual(60);
  });

  it('keeps bodies within the stored byte budget when the provider always returns full pages', async () => {
    const longBody = 'y'.repeat(200);
    mockListReviewComments.mockImplementation(async ({ page }: { page: number }) => ({
      data: Array.from({ length: PER_PAGE }, (_, index) => ({
        id: page * PER_PAGE + index + 1,
        path: 'src/file.ts',
        line: index + 1,
        body: longBody,
        position: index,
        user: { login: 'reviewer' },
      })),
    }));

    const comments = await fetchPRInlineComments('42', 'acme', 'widgets', 7);

    // Bodies are truncated to 60 chars before counting, so the page cap (5 pages
    // × 100 × 60 bytes = 30 KB) is the binding bound, under the 64 KB budget.
    const totalBytes = comments.reduce((sum, c) => sum + Buffer.byteLength(c.body), 0);
    expect(totalBytes).toBeLessThanOrEqual(64 * 1024);
    expect(mockListReviewComments).toHaveBeenCalledTimes(MAX_PAGES);
  });

  it('stops on the stored byte budget before the page cap for multi-byte bodies', async () => {
    const multiByteBody = '漢'.repeat(200);
    const bytesPerStoredBody = Buffer.byteLength(multiByteBody.slice(0, 60));
    expect(bytesPerStoredBody).toBe(180);
    const expectedStored = Math.ceil((64 * 1024) / bytesPerStoredBody);

    mockListReviewComments.mockImplementation(async ({ page }: { page: number }) => ({
      data: Array.from({ length: PER_PAGE }, (_, index) => ({
        id: page * PER_PAGE + index + 1,
        path: 'src/file.ts',
        line: index + 1,
        body: multiByteBody,
        position: index,
        user: { login: 'reviewer' },
      })),
    }));

    const comments = await fetchPRInlineComments('42', 'acme', 'widgets', 7);

    expect(comments).toHaveLength(expectedStored);
    expect(mockListReviewComments.mock.calls.length).toBeLessThan(MAX_PAGES);
    const totalBytes = comments.reduce((sum, c) => sum + Buffer.byteLength(c.body), 0);
    expect(totalBytes).toBeGreaterThanOrEqual(64 * 1024);
  });
});

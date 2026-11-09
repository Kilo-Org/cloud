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

const mockGetGitHubAppCredentials = jest.fn();
jest.mock('./app-selector', () => ({
  getGitHubAppCredentials: (...args: unknown[]) => mockGetGitHubAppCredentials(...args),
}));

import { fetchPRInlineComments } from './adapter';

function comment(overrides: Record<string, unknown>) {
  return {
    id: 1,
    path: 'src/file.ts',
    line: 10,
    body: 'comment body',
    position: 0,
    user: { login: 'someone' },
    ...overrides,
  };
}

beforeEach(() => {
  mockListReviewComments.mockReset();
  mockGetGitHubAppCredentials.mockReset();
  mockGetGitHubAppCredentials.mockReturnValue({ appId: 'test-app-id', privateKey: 'test-key' });
});

describe('fetchPRInlineComments authorship', () => {
  it('marks only comments created by the configured app as Kilo-authored', async () => {
    mockListReviewComments.mockResolvedValueOnce({
      data: [
        comment({ id: 1, performed_via_github_app: { id: 'test-app-id' } }),
        comment({ id: 2, performed_via_github_app: { id: 999 } }),
        comment({ id: 3, performed_via_github_app: null }),
        comment({ id: 4 }),
      ],
    });

    const comments = await fetchPRInlineComments('42', 'acme', 'widgets', 7);

    expect(comments.map(c => [c.id, c.authoredByKilo])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
    ]);
  });

  it('treats a comment without a diff position as outdated', async () => {
    const { position: _omitted, ...withoutPosition } = comment({
      id: 1,
      performed_via_github_app: { id: 'test-app-id' },
    });
    mockListReviewComments.mockResolvedValueOnce({
      data: [withoutPosition, comment({ id: 2, position: null }), comment({ id: 3, position: 0 })],
    });

    const comments = await fetchPRInlineComments('42', 'acme', 'widgets', 7);

    expect(comments.map(c => [c.id, c.isOutdated])).toEqual([
      [1, true],
      [2, true],
      [3, false],
    ]);
  });

  it('marks comments authored through the lite app when the review uses the lite app', async () => {
    mockGetGitHubAppCredentials.mockReturnValue({ appId: 'test-lite-app-id', privateKey: 'key' });
    mockListReviewComments.mockResolvedValueOnce({
      data: [
        comment({ id: 1, performed_via_github_app: { id: 'test-lite-app-id' } }),
        comment({ id: 2, performed_via_github_app: { id: 'test-app-id' } }),
      ],
    });

    const comments = await fetchPRInlineComments('42', 'acme', 'widgets', 7, 'lite');

    expect(comments.map(c => [c.id, c.authoredByKilo])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(mockGetGitHubAppCredentials).toHaveBeenCalledWith('lite');
  });
});

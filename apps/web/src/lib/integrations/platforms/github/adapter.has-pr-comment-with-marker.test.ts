/**
 * The GitHub adapter is globally mocked through the `@/` alias in Jest config.
 * Import the relative module path here so this test exercises the real adapter.
 */

process.env.GITHUB_APP_ID = 'test-app-id';
process.env.GITHUB_APP_PRIVATE_KEY = 'test-private-key';

const mockPaginate = jest.fn();

jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(async () => undefined),
}));

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    issues: { listComments: jest.fn() },
    paginate: mockPaginate,
  })),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(() => async () => ({ token: 'mock-token', expiresAt: '2099-01-01' })),
}));

import { hasPRCommentWithMarker } from './adapter';

const MARKER = '<!-- billing-notice -->';

beforeEach(() => {
  mockPaginate.mockReset();
});

describe('hasPRCommentWithMarker', () => {
  it('reports a marked comment written by this App', async () => {
    mockPaginate.mockResolvedValueOnce([
      { id: 1, body: 'ordinary discussion', performed_via_github_app: null },
      {
        id: 2,
        body: `${MARKER}\nBilling notice`,
        performed_via_github_app: { id: 'test-app-id' },
      },
    ]);

    await expect(hasPRCommentWithMarker('42', 'acme', 'widgets', 7, MARKER)).resolves.toBe(true);
  });

  it('ignores marked comments written by anyone else', async () => {
    mockPaginate.mockResolvedValueOnce([
      { id: 1, body: `${MARKER}\nCopied`, performed_via_github_app: { id: 'someone-else' } },
      { id: 2, body: `${MARKER}\nNo app attribution`, performed_via_github_app: null },
      {
        id: 3,
        body: `${MARKER}\nUser-authored`,
        performed_via_github_app: { id: 'test-app-id-2' },
      },
    ]);

    await expect(hasPRCommentWithMarker('42', 'acme', 'widgets', 7, MARKER)).resolves.toBe(false);
  });
});

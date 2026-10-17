const mockPullsCreate = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    pulls: { create: mockPullsCreate },
  })),
}));

jest.mock('@/lib/utils.server', () => ({
  logExceptInTest: jest.fn(),
  warnExceptInTest: jest.fn(),
  errorExceptInTest: jest.fn(),
}));

jest.mock('@/lib/integrations/github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(),
}));

jest.mock('./app-selector', () => ({
  getGitHubAppCredentials: () => ({
    clientId: 'github-client-id',
    clientSecret: 'github-client-secret',
  }),
}));

import { createGitHubPullRequest } from './adapter';

const baseParams = {
  token: 'ghs_token',
  owner: 'Kilo-Org',
  repo: 'kilo-cloud',
  title: 'Fix the thing',
  body: 'Body',
  headBranch: 'session/abc',
  baseBranch: 'main',
};

describe('createGitHubPullRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPullsCreate.mockResolvedValue({ data: { number: 3, html_url: 'https://github.com/pr/3' } });
  });

  it('omits head_repo and sends a bare head for a same-repository pull', async () => {
    const result = await createGitHubPullRequest(baseParams);

    expect(result).toEqual({ number: 3, url: 'https://github.com/pr/3' });
    expect(mockPullsCreate).toHaveBeenCalledWith({
      owner: 'Kilo-Org',
      repo: 'kilo-cloud',
      title: 'Fix the thing',
      body: 'Body',
      head: 'session/abc',
      base: 'main',
    });
  });

  it('qualifies the head and names the head repository for a cross-fork pull', async () => {
    await createGitHubPullRequest({
      ...baseParams,
      headRepo: 'maphew/kilo-cloud',
    });

    expect(mockPullsCreate).toHaveBeenCalledWith({
      owner: 'Kilo-Org',
      repo: 'kilo-cloud',
      title: 'Fix the thing',
      body: 'Body',
      head: 'maphew:session/abc',
      base: 'main',
      head_repo: 'maphew/kilo-cloud',
    });
  });

  it('rejects a malformed head repository before calling GitHub', async () => {
    await expect(
      createGitHubPullRequest({ ...baseParams, headRepo: 'not-a-full-name' })
    ).rejects.toThrow('Invalid head repository name format: not-a-full-name');
    expect(mockPullsCreate).not.toHaveBeenCalled();
  });
});

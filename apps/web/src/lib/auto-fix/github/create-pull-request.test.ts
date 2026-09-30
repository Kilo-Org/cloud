const mockFetch = jest.fn();

jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
}));

jest.mock('@/lib/utils.server', () => ({
  logExceptInTest: jest.fn(),
  errorExceptInTest: jest.fn(),
}));

import { createPullRequest } from '@/lib/auto-fix/github/create-pull-request';

function jsonResponse(body: unknown, init?: { status?: number; statusText?: string }) {
  const status = init?.status ?? 200;
  return {
    ok: status < 400,
    status,
    statusText: init?.statusText ?? 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const baseParams = {
  repoFullName: 'Kilo-Org/kilo-cloud',
  baseBranch: 'main',
  headBranch: 'session/abc',
  title: 'Fix the thing',
  body: 'Body',
  githubToken: 'ghs_token',
};

const originalFetch = global.fetch;

describe('createPullRequest', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    global.fetch = mockFetch as unknown as typeof fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('verifies the head branch in the base repository and posts a same-repo body', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ ref: 'refs/heads/session/abc' }))
      .mockResolvedValueOnce(jsonResponse({ number: 7, html_url: 'https://github.com/pr/7' }));

    const result = await createPullRequest(baseParams);

    expect(result).toEqual({ number: 7, url: 'https://github.com/pr/7' });

    const [refUrl, refInit] = mockFetch.mock.calls[0];
    expect(refUrl).toBe(
      'https://api.github.com/repos/Kilo-Org/kilo-cloud/git/ref/heads/session%2Fabc'
    );
    expect(refInit.headers.Authorization).toBe('Bearer ghs_token');

    const [pullsUrl, pullsInit] = mockFetch.mock.calls[1];
    expect(pullsUrl).toBe('https://api.github.com/repos/Kilo-Org/kilo-cloud/pulls');
    expect(JSON.parse(pullsInit.body)).toEqual({
      title: 'Fix the thing',
      body: 'Body',
      head: 'session/abc',
      base: 'main',
    });
  });

  it('verifies the head branch in the fork and names the head repository for a cross-fork pull', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResponse({ ref: 'refs/heads/session/abc' }))
      .mockResolvedValueOnce(jsonResponse({ number: 9, html_url: 'https://github.com/pr/9' }));

    const result = await createPullRequest({
      ...baseParams,
      headRepoFullName: 'maphew/kilo-cloud',
    });

    expect(result).toEqual({ number: 9, url: 'https://github.com/pr/9' });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [refUrl] = mockFetch.mock.calls[0];
    expect(refUrl).toBe(
      'https://api.github.com/repos/maphew/kilo-cloud/git/ref/heads/session%2Fabc'
    );

    const [pullsUrl, pullsInit] = mockFetch.mock.calls[1];
    expect(pullsUrl).toBe('https://api.github.com/repos/Kilo-Org/kilo-cloud/pulls');
    expect(JSON.parse(pullsInit.body)).toEqual({
      title: 'Fix the thing',
      body: 'Body',
      head: 'maphew:session/abc',
      base: 'main',
      head_repo: 'maphew/kilo-cloud',
    });
  });

  it('reports the same-repo reason when the branch was never pushed', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' })
    );

    await expect(createPullRequest(baseParams)).rejects.toThrow(
      "Branch 'session/abc' does not exist on GitHub"
    );
  });

  it('blames the fork and the app installation rather than the branch when the fork cannot be read', async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse({ message: 'Not Found' }, { status: 404, statusText: 'Not Found' })
    );

    await expect(
      createPullRequest({ ...baseParams, headRepoFullName: 'maphew/kilo-cloud' })
    ).rejects.toThrow(
      "Branch 'session/abc' could not be read from maphew/kilo-cloud on GitHub (HTTP 404). Either it was never pushed there, or the GitHub App is not installed on that repository."
    );
  });

  it('rejects a malformed head repository full name before calling GitHub', async () => {
    await expect(
      createPullRequest({ ...baseParams, headRepoFullName: 'not-a-full-name' })
    ).rejects.toThrow('Invalid repository name format: not-a-full-name');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed base repository full name before calling GitHub', async () => {
    await expect(createPullRequest({ ...baseParams, repoFullName: 'kilo-cloud' })).rejects.toThrow(
      'Invalid repository name format: kilo-cloud'
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects an empty head branch before calling GitHub', async () => {
    await expect(createPullRequest({ ...baseParams, headBranch: 'refs/heads/' })).rejects.toThrow(
      'Pull request head branch must not be empty'
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

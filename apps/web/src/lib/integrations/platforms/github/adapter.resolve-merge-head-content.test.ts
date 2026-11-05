const mockGetCommit = jest.fn();
const mockCompareCommits = jest.fn();

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    git: { getCommit: mockGetCommit },
    repos: { compareCommits: mockCompareCommits },
  })),
}));

jest.mock('@octokit/auth-app', () => ({
  createAppAuth: jest.fn(() => async () => ({
    token: 'installation-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
  })),
}));

jest.mock('../../github/runtime-authorization', () => ({
  assertGitHubInstallationRuntimeAuthorized: jest.fn(),
}));

jest.mock('./app-selector', () => ({
  getGitHubAppCredentials: () => ({
    clientId: 'github-client-id',
    clientSecret: 'github-client-secret',
    appId: '123',
    privateKey: 'private-key',
  }),
}));

import { resolveMergeHeadContent } from './adapter';

const baseArgs = {
  appType: 'standard' as const,
  baseSha: 'base-sha',
  headSha: 'head-sha',
  installationId: '98765',
  owner: 'acme',
  repo: 'widgets',
};

// Every commit in this fake graph is addressed by sha; a merge lists two parents.
function commitGraph(parentsBySha: Record<string, readonly string[]>) {
  mockGetCommit.mockImplementation(async ({ commit_sha }: { commit_sha: string }) => {
    const parents = parentsBySha[commit_sha] ?? [];
    return { data: { parents: parents.map(sha => ({ sha })) } };
  });
}

describe('resolveMergeHeadContent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCompareCommits.mockResolvedValue({ data: { status: 'behind' } });
  });

  it('reports a head with one parent as no merge without comparing anything', async () => {
    commitGraph({ 'head-sha': ['content-sha'], 'content-sha': ['older-sha'] });

    const content = await resolveMergeHeadContent(baseArgs);

    expect(content).toEqual({ kind: 'not_merge' });
    expect(mockCompareCommits).not.toHaveBeenCalled();
  });

  it('names the merge head and the branch commit it carries', async () => {
    commitGraph({ 'head-sha': ['content-sha', 'base-parent'], 'content-sha': ['older-sha'] });

    const content = await resolveMergeHeadContent(baseArgs);

    expect(content).toEqual({
      kind: 'review_content',
      shas: ['head-sha', 'content-sha'],
    });
    expect(mockCompareCommits).toHaveBeenCalledWith({
      base: 'base-sha',
      head: 'base-parent',
      owner: 'acme',
      repo: 'widgets',
    });
  });

  it('keeps the whole chain of stacked base-branch merges', async () => {
    commitGraph({
      'head-sha': ['first-merge', 'base-parent-2'],
      'first-merge': ['content-sha', 'base-parent-1'],
      'content-sha': ['older-sha'],
    });

    const content = await resolveMergeHeadContent(baseArgs);

    expect(content).toEqual({
      kind: 'review_content',
      shas: ['head-sha', 'first-merge', 'content-sha'],
    });
  });

  it('reports unreviewed content when a merge takes a branch from outside the base', async () => {
    commitGraph({
      'head-sha': ['content-sha', 'feature-parent'],
      'content-sha': ['older-sha'],
    });
    mockCompareCommits.mockResolvedValue({ data: { status: 'ahead' } });

    const content = await resolveMergeHeadContent(baseArgs);

    expect(content).toEqual({ kind: 'unreviewed_content' });
  });

  it('accepts a second parent identical to the base commit', async () => {
    commitGraph({ 'head-sha': ['content-sha', 'base-parent'], 'content-sha': ['older-sha'] });
    mockCompareCommits.mockResolvedValue({ data: { status: 'identical' } });

    const content = await resolveMergeHeadContent(baseArgs);

    expect(content).toEqual({ kind: 'review_content', shas: ['head-sha', 'content-sha'] });
  });

  it('reports unreviewed content when a commit cannot be read', async () => {
    mockGetCommit.mockRejectedValue(new Error('github unavailable'));

    const content = await resolveMergeHeadContent(baseArgs);

    expect(content).toEqual({ kind: 'unreviewed_content' });
  });

  it('reports unreviewed content when the merge chain exceeds the walk limit', async () => {
    // Every commit is a merge whose second parent is base content, so only the limit ends the walk.
    const graph: Record<string, readonly string[]> = {};
    let current = 'head-sha';
    for (let depth = 0; depth <= 20; depth += 1) {
      const next = `merge-${depth}`;
      graph[current] = [next, 'base-parent'];
      current = next;
    }
    commitGraph(graph);

    const content = await resolveMergeHeadContent(baseArgs);

    expect(content).toEqual({ kind: 'unreviewed_content' });
  });
});

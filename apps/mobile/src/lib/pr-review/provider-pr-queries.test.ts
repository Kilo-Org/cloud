/* eslint-disable max-lines -- the namespace-selection tests and the pure normalizer tests share the same stubbed-trpc harness. */
import { describe, expect, it, vi } from 'vitest';

import {
  buildPrChecksQueryOptions,
  buildPrFileLinesQueryOptions,
  buildPrFilesQueryOptions,
  buildPrMergeStateQueryOptions,
  buildPrOverviewQueryOptions,
  buildPrThreadsQueryOptions,
  normalizeProviderChecks,
  normalizeProviderOverview,
  normalizeProviderThreadsPage,
  normalizePrThreadsPages,
  providerCapabilitiesIdentity,
} from './provider-pr-queries';
import { githubPrRef, isProviderScopeReady, type ProviderPrScope } from './provider-pr-ref';

// `provider-pr-queries` imports `useTRPC` from `@/lib/trpc`, which pulls the
// whole expo auth/token module graph. Mock it so the module loads under Node.
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({}) }));

type Trpc = Parameters<typeof buildPrOverviewQueryOptions>[0];

// Every read procedure both namespaces answer, stubbed by name so a builder
// that picked the wrong namespace shows up as the wrong `procedure` tag.
const GITHUB_PROCEDURES = ['getPullRequest', 'listChecks', 'listFiles', 'listReviewThreads'];
const PROVIDER_PROCEDURES = ['listDiscussions', 'getFileLines', 'getMergeState', 'getCapabilities'];

function makeTrpc() {
  const record = (name: string) =>
    vi.fn((input: unknown, opts: Record<string, unknown> = {}) => ({
      procedure: name,
      input,
      ...opts,
    }));
  const query = (namespace: string, name: string) => ({
    queryOptions: record(`${namespace}.${name}`),
    infiniteQueryOptions: record(`${namespace}.${name}`),
  });
  const namespaceOf = (namespace: string) =>
    Object.fromEntries(
      [...GITHUB_PROCEDURES, ...PROVIDER_PROCEDURES].map(name => [name, query(namespace, name)])
    );
  const trpc = { githubPrReview: namespaceOf('github'), providerReview: namespaceOf('provider') };
  return { trpc: trpc as unknown as Trpc };
}

const githubScope: ProviderPrScope = {
  ref: githubPrRef('octocat', 'hello', 7),
  organizationId: null,
};
const gitlabScope: ProviderPrScope = {
  ref: { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
  organizationId: null,
};
const bitbucketScope: ProviderPrScope = {
  ref: { platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 42 },
  organizationId: 'org-1',
};

/** First element, asserted present — `noUncheckedIndexedAccess` is on. */
function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error('expected at least one item');
  }
  return item;
}

function loose(options: unknown) {
  return options as {
    procedure: string;
    input: Record<string, unknown>;
    enabled?: boolean;
    getNextPageParam?: (page: { nextCursor: string | null }) => unknown;
  };
}

describe('namespace selection', () => {
  it('sends a GitHub ref to githubPrReview with the owner/repo/number input', () => {
    const { trpc } = makeTrpc();
    const overview = loose(buildPrOverviewQueryOptions(trpc, githubScope));
    expect(overview.procedure).toBe('github.getPullRequest');
    expect(overview.input).toEqual({ owner: 'octocat', repo: 'hello', number: 7 });
    expect(loose(buildPrChecksQueryOptions(trpc, githubScope, 'abc')).input).toEqual({
      owner: 'octocat',
      repo: 'hello',
      ref: 'abc',
    });
    expect(loose(buildPrFilesQueryOptions(trpc, githubScope, true)).procedure).toBe(
      'github.listFiles'
    );
    expect(loose(buildPrThreadsQueryOptions(trpc, githubScope)).procedure).toBe(
      'github.listReviewThreads'
    );
  });

  it('sends a GitLab ref to providerReview with the full nested project path', () => {
    const { trpc } = makeTrpc();
    const overview = loose(buildPrOverviewQueryOptions(trpc, gitlabScope));
    expect(overview.procedure).toBe('provider.getPullRequest');
    expect(overview.input).toEqual({
      platform: 'gitlab',
      projectPath: 'group/sub/repo',
      mrIid: 12,
    });
    expect(loose(buildPrThreadsQueryOptions(trpc, gitlabScope)).procedure).toBe(
      'provider.listDiscussions'
    );
  });

  it('carries the GitLab instance hint and the selected organization', () => {
    const ref = {
      platform: 'gitlab',
      projectPath: 'group/repo',
      mrIid: 3,
      instanceHint: 'gitlab.example.com',
    } as const;
    const { trpc } = makeTrpc();
    expect(
      loose(buildPrOverviewQueryOptions(trpc, { ref, organizationId: 'org-9' })).input
    ).toEqual({ ...ref, organizationId: 'org-9' });
  });

  it('sends a Bitbucket ref with workspace, repo slug and organization', () => {
    const { trpc } = makeTrpc();
    expect(loose(buildPrOverviewQueryOptions(trpc, bitbucketScope)).input).toEqual({
      ...bitbucketScope.ref,
      organizationId: 'org-1',
    });
  });

  it('keeps the same expanded-context procedure shape for every provider', () => {
    const { trpc } = makeTrpc();
    const input = { ref: 'sha', path: 'src/a.ts', startLine: 1, endLine: 20 };
    expect(loose(buildPrFileLinesQueryOptions(trpc, githubScope, input)).input).toMatchObject({
      owner: 'octocat',
      repo: 'hello',
      ...input,
    });
    expect(loose(buildPrFileLinesQueryOptions(trpc, gitlabScope, input)).input).toMatchObject({
      platform: 'gitlab',
      projectPath: 'group/sub/repo',
      ...input,
    });
  });

  it('keeps the GitHub merge-state query disabled (the overview carries the gate)', () => {
    const { trpc } = makeTrpc();
    // The GitHub arm registers a never-enabled query so the hook keeps one
    // type; nothing leaves the app on that path.
    const githubOptions = loose(buildPrMergeStateQueryOptions(trpc, githubScope));
    expect(githubOptions.procedure).toBe('provider.getMergeState');
    expect(githubOptions.enabled).toBe(false);
    const gitlabOptions = loose(buildPrMergeStateQueryOptions(trpc, gitlabScope));
    expect(gitlabOptions.procedure).toBe('provider.getMergeState');
    expect(gitlabOptions.enabled).toBe(true);
  });

  it('builds the capability identity from the platform, never a repository ref', () => {
    // The `getCapabilities` query itself stays at its call site (the option
    // type only resolves inline); the seam owns the identity it reads under.
    expect(providerCapabilitiesIdentity(gitlabScope)).toEqual({ platform: 'gitlab' });
    expect(
      providerCapabilitiesIdentity({
        ref: {
          platform: 'gitlab',
          projectPath: 'g/r',
          mrIid: 1,
          instanceHint: 'gitlab.example.com',
        },
        organizationId: 'org-2',
      })
    ).toEqual({ platform: 'gitlab', instanceHint: 'gitlab.example.com', organizationId: 'org-2' });
    expect(providerCapabilitiesIdentity(bitbucketScope)).toEqual({
      platform: 'bitbucket',
      organizationId: 'org-1',
    });
  });

  it('paginates each provider on its own opaque cursor', () => {
    const { trpc } = makeTrpc();
    const files = loose(buildPrFilesQueryOptions(trpc, gitlabScope, true));
    const page: { nextCursor: string | null } = { nextCursor: 'page-2' };
    expect(files.getNextPageParam?.(page)).toBe('page-2');
    expect(files.getNextPageParam?.({ nextCursor: null })).toBeUndefined();
  });
});

describe('organization readiness', () => {
  it('disables a Bitbucket query until an organization is selected', () => {
    const { trpc } = makeTrpc();
    const scope = { ...bitbucketScope, organizationId: null };
    expect(isProviderScopeReady(scope)).toBe(false);
    expect(loose(buildPrOverviewQueryOptions(trpc, scope)).enabled).toBe(false);
    expect(loose(buildPrChecksQueryOptions(trpc, scope, 'sha')).enabled).toBe(false);
    expect(loose(buildPrFilesQueryOptions(trpc, scope, true)).enabled).toBe(false);
  });

  it('runs GitHub and personal GitLab without an organization, and honours enabled', () => {
    const { trpc } = makeTrpc();
    expect([githubScope, gitlabScope].every(scope => isProviderScopeReady(scope))).toBe(true);
    expect(loose(buildPrFilesQueryOptions(trpc, bitbucketScope, false)).enabled).toBe(false);
    expect(loose(buildPrFilesQueryOptions(trpc, bitbucketScope, true)).enabled).toBe(true);
  });
});

describe('normalizeProviderChecks', () => {
  it('maps provider run states onto the vocabulary the checks section reads', () => {
    const result = normalizeProviderChecks({
      checks: [
        { name: 'build', status: 'success', conclusion: 'success', detailsUrl: 'https://x/1' },
        { name: 'test', status: 'failed', conclusion: 'failed', detailsUrl: null },
        { name: 'lint', status: 'running', conclusion: null, detailsUrl: null },
        { name: 'deploy', status: 'canceled', conclusion: 'canceled', detailsUrl: null },
      ],
    });
    expect(result.checkRuns.map(run => [run.status, run.conclusion])).toEqual([
      ['completed', 'success'],
      ['completed', 'failure'],
      ['in_progress', null],
      ['completed', 'cancelled'],
    ]);
    expect(result.rollup).toEqual({ total: 4, success: 1, failure: 1, pending: 1, skipped: 1 });
    // Empty: a provider with no pipeline at all reports a zeroed rollup.
    const empty = { total: 0, success: 0, failure: 0, pending: 0, skipped: 0 };
    expect(normalizeProviderChecks({ checks: [] })).toEqual({ checkRuns: [], rollup: empty });
  });
});

describe('normalizeProviderThreadsPage', () => {
  const comment = {
    commentId: '4821',
    author: { login: 'ada', avatarUrl: null },
    body: 'nit',
    createdAt: '2026-01-01T00:00:00Z',
  };
  const thread = {
    threadId: 'disc-1',
    resolved: true,
    path: 'src/a.ts',
    line: 12,
    side: 'RIGHT' as const,
    comments: [comment],
  };

  it('maps a line-anchored resolved thread', () => {
    const page = normalizeProviderThreadsPage({ threads: [thread], nextCursor: 'c2' });
    expect(page.nextCursor).toBe('c2');
    expect(page.conversation).toEqual([]);
    expect(first(page.threads)).toMatchObject({
      threadId: 'disc-1',
      isResolved: true,
      isOutdated: false,
      subjectType: 'LINE',
      path: 'src/a.ts',
      line: 12,
      diffSide: 'RIGHT',
    });
    // Reactions come from no provider read layer, and Bitbucket has none.
    expect(first(first(page.threads).comments)).toMatchObject({
      commentId: 4821,
      nodeId: '4821',
      reactions: [],
    });
  });

  it('treats an unanchored discussion as a file-level thread', () => {
    const page = normalizeProviderThreadsPage({
      threads: [{ ...thread, path: null, line: null, side: null }],
      nextCursor: null,
    });
    expect(first(page.threads).subjectType).toBe('FILE');
    expect(first(page.threads).line).toBeNull();
  });

  it('gives a non-numeric provider comment id a stable positive key', () => {
    const build = () =>
      first(
        first(
          normalizeProviderThreadsPage({
            threads: [{ ...thread, comments: [{ ...comment, commentId: 'ab12cd' }] }],
            nextCursor: null,
          }).threads
        ).comments
      );
    expect(build().commentId).toBe(build().commentId);
    expect(build().commentId).toBeGreaterThan(0);
    expect(build().nodeId).toBe('ab12cd');
  });

  it('passes GitHub pages through untouched and maps provider pages', () => {
    const githubPage = { threads: [], conversation: [], nextCursor: null };
    expect(normalizePrThreadsPages('github', [githubPage])).toEqual([githubPage]);
    const mapped = normalizePrThreadsPages('gitlab', [
      { threads: [thread], nextCursor: null },
    ] as never);
    expect(first(first(mapped).threads).threadId).toBe('disc-1');
    expect(normalizePrThreadsPages('gitlab', undefined)).toEqual([]);
  });
});

describe('normalizeProviderOverview', () => {
  const summary = {
    ref: { platform: 'gitlab' as const, projectPath: 'group/sub/repo', mrIid: 12 },
    title: 'Fix the thing',
    body: '## why',
    author: { login: 'ada', avatarUrl: null },
    state: 'open' as const,
    draft: true,
    headRef: 'feature',
    baseRef: 'main',
    headSha: 'deadbeef',
    changedFiles: 3,
    additions: 10,
    deletions: 2,
    webUrl: 'https://gitlab.example.com/group/sub/repo/-/merge_requests/12',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  } as const;

  it('renders as the overview model the screens already consume', () => {
    expect(normalizeProviderOverview(summary)).toMatchObject({
      number: 12,
      title: 'Fix the thing',
      bodyMarkdown: '## why',
      state: 'open',
      draft: true,
      baseRef: 'main',
      headRef: 'feature',
      headSha: 'deadbeef',
      headRepoFullName: 'group/sub/repo',
      isCrossRepo: false,
      // commits is null, never 0: no provider read layer reports a commit
      // count, and "0 commits" would state a wrong fact rather than an absent one.
      counts: { commits: null, changedFiles: 3, additions: 10, deletions: 2 },
    });
  });

  it('degrades the GitHub-only sections to empty instead of inventing them', () => {
    expect(normalizeProviderOverview(summary)).toMatchObject({
      labels: [],
      reviewers: [],
      assignees: [],
      linkedIssues: [],
      reviewDecision: null,
      mergeable: null,
    });
  });

  it('derives merge affordances from the provider capabilities', () => {
    const gitlab = normalizeProviderOverview(summary);
    const bitbucket = normalizeProviderOverview({
      ...summary,
      ref: { platform: 'bitbucket', workspace: 'group', repoSlug: 'repo', prId: 12 },
    });
    expect(gitlab.repo.allowAutoMerge).toBe(true);
    // Bitbucket Cloud does not expose auto-merge in its API (s1 capability).
    expect(bitbucket.repo.allowAutoMerge).toBe(false);
    expect(bitbucket.repo.allowMergeCommit).toBe(true);
    // Two same-named repositories on different providers stay apart.
    expect(gitlab.prNodeId).not.toBe(bitbucket.prNodeId);
  });
});

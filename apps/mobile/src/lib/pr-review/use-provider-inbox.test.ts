import { describe, expect, it, vi } from 'vitest';

import { classifyPrReviewQueryState } from './classify-pr-review-query-state';
import {
  buildBitbucketInboxQueryOptions,
  buildGitLabInboxQueryOptions,
  inboxRetryAction,
  mergeProviderInboxSources,
  type ProviderInboxSource,
  toGitHubInboxRows,
  toProviderInboxRows,
} from './use-provider-inbox';

// The hook module reaches the tRPC client, the organization context and the
// connection-status hooks; mock them so the pure exports load under Node.
vi.mock('@/lib/trpc', () => ({ useTRPC: () => ({}) }));
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({ organizationId: null }),
}));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  useGitLabStatus: () => ({ data: undefined }),
  useBitbucketReadiness: () => ({ data: undefined }),
}));
vi.mock('@/lib/pr-review/use-pr-inbox', () => ({ usePrInbox: () => ({}) }));

type Trpc = Parameters<typeof buildGitLabInboxQueryOptions>[0];

function makeTrpc() {
  const infiniteQueryOptions = vi.fn((input: unknown, opts: Record<string, unknown>) => ({
    input,
    ...opts,
  }));
  return {
    trpc: { providerReview: { listInbox: { infiniteQueryOptions } } } as unknown as Trpc,
    infiniteQueryOptions,
  };
}

function loose(options: unknown) {
  return options as {
    input: Record<string, unknown>;
    enabled: boolean;
    maxPages: number;
    getNextPageParam: (page: { nextCursor: string | null }) => string | undefined;
  };
}

function source(overrides: Partial<ProviderInboxSource>): ProviderInboxSource {
  return {
    platform: 'github',
    enabled: true,
    rows: [],
    isPending: false,
    hasLoadedPages: true,
    error: null,
    hasNextPage: false,
    isFetchingNextPage: false,
    ...overrides,
  };
}

const githubRows = toGitHubInboxRows([
  {
    owner: 'octocat',
    repo: 'hello',
    number: 7,
    title: 'GitHub PR',
    isDraft: false,
    updatedAt: '2026-01-02T00:00:00Z',
  },
]);

const gitlabRows = toProviderInboxRows([
  {
    ref: { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
    title: 'GitLab MR',
    author: null,
    state: 'open',
    draft: true,
    updatedAt: '2026-01-03T00:00:00Z',
  },
]);

const bitbucketRows = toProviderInboxRows([
  {
    ref: { platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 42 },
    title: 'Bitbucket PR',
    author: null,
    state: 'open',
    draft: false,
    updatedAt: '2026-01-01T00:00:00Z',
  },
]);

describe('inbox rows', () => {
  it('carries the full ref and the provider draft flag', () => {
    expect(gitlabRows[0]).toMatchObject({
      ref: { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
      title: 'GitLab MR',
      isDraft: true,
    });
    expect(githubRows[0]).toMatchObject({
      ref: { platform: 'github', owner: 'octocat', repo: 'hello', number: 7 },
      isDraft: false,
    });
  });

  it('keys same-named repositories on different providers apart', () => {
    const github = toGitHubInboxRows([
      { owner: 'group', repo: 'repo', number: 5, title: 't', isDraft: false, updatedAt: '' },
    ]);
    const gitlab = toProviderInboxRows([
      {
        ref: { platform: 'gitlab', projectPath: 'group/repo', mrIid: 5 },
        title: 't',
        author: null,
        state: 'open',
        draft: false,
        updatedAt: '',
      },
    ]);
    expect(github[0]?.key).not.toBe(gitlab[0]?.key);
  });
});

describe('mergeProviderInboxSources', () => {
  it('merges every enabled provider newest-first', () => {
    const merged = mergeProviderInboxSources([
      source({ platform: 'github', rows: githubRows }),
      source({ platform: 'gitlab', rows: gitlabRows }),
      source({ platform: 'bitbucket', rows: bitbucketRows }),
    ]);
    expect(merged.items.map(row => row.title)).toEqual(['GitLab MR', 'GitHub PR', 'Bitbucket PR']);
  });

  it('sorts without the ES2023 copy-returning methods Hermes lacks', () => {
    // The device runtime is Hermes: Array.prototype.{toSorted,toReversed,
    // toSpliced,with} do not exist there, so the merge must go through the
    // mutating API. Deleting them in Node reproduces the device crash the
    // inbox shipped with (e12: `undefined is not a function` on `.toSorted`).
    const methods = ['toSorted', 'toReversed', 'toSpliced', 'with'];
    const restored = methods.map(method => [
      method,
      Object.getOwnPropertyDescriptor(Array.prototype, method),
    ] as const);
    for (const method of methods) {
      delete (Array.prototype as Record<string, unknown>)[method];
    }
    try {
      const merged = mergeProviderInboxSources([
        source({ platform: 'github', rows: githubRows }),
        source({ platform: 'gitlab', rows: gitlabRows }),
      ]);
      expect(merged.items.map(row => row.title)).toEqual(['GitLab MR', 'GitHub PR']);
    } finally {
      for (const [method, descriptor] of restored) {
        if (descriptor) {
          Object.defineProperty(Array.prototype, method, descriptor);
        }
      }
    }
  });

  it('ignores a provider the user has not connected', () => {
    const merged = mergeProviderInboxSources([
      source({ platform: 'github', rows: githubRows }),
      source({ platform: 'gitlab', rows: gitlabRows, enabled: false }),
    ]);
    expect(merged.items.map(row => row.title)).toEqual(['GitHub PR']);
  });

  it('stays pending while any enabled provider still owes its first page', () => {
    const pending = source({ isPending: true, hasLoadedPages: false });
    expect(mergeProviderInboxSources([pending, { ...pending, platform: 'gitlab' }]).isPending).toBe(
      true
    );
    // The GitLab REST inbox answers empty while GitHub's GraphQL one is still
    // in flight: reporting "settled" here would render "No review requests"
    // and then replace it with GitHub's rows.
    expect(
      mergeProviderInboxSources([
        source({ platform: 'github', isPending: true, hasLoadedPages: false }),
        source({ platform: 'gitlab', isPending: false, rows: [] }),
      ]).isPending
    ).toBe(true);
  });

  it('never sends a list that already has rows back to the skeletons', () => {
    // A provider whose connection status resolves late becomes enabled (and
    // pending) after another provider has already painted rows.
    const merged = mergeProviderInboxSources([
      source({ platform: 'github', rows: githubRows }),
      source({ platform: 'gitlab', isPending: true, hasLoadedPages: false }),
    ]);
    expect(merged.isPending).toBe(false);
    expect(merged.items.map(row => row.title)).toEqual(['GitHub PR']);
  });

  it('settles to empty only once every enabled provider has answered', () => {
    expect(
      mergeProviderInboxSources([
        source({ platform: 'github', rows: [] }),
        source({ platform: 'gitlab', rows: [] }),
      ]).isPending
    ).toBe(false);
  });

  it('is empty, not pending, when no provider is enabled', () => {
    const merged = mergeProviderInboxSources([source({ enabled: false })]);
    expect(merged.items).toEqual([]);
    expect(merged.isPending).toBe(false);
    expect(merged.firstPageErrorState).toBeNull();
  });

  it('blanks the list only when every enabled provider failed its first page', () => {
    const error = new Error('boom');
    const merged = mergeProviderInboxSources([
      source({ platform: 'github', error, hasLoadedPages: false }),
      source({ platform: 'gitlab', error, hasLoadedPages: false }),
    ]);
    expect(merged.firstPageErrorState).toEqual(classifyPrReviewQueryState(error));
    expect(merged.laterPageError).toBe(false);
  });

  it('keeps a working provider visible when another one fails', () => {
    const merged = mergeProviderInboxSources([
      source({ platform: 'github', rows: githubRows }),
      source({ platform: 'gitlab', error: new Error('gitlab down'), hasLoadedPages: false }),
    ]);
    expect(merged.firstPageErrorState).toBeNull();
    expect(merged.items.map(row => row.title)).toEqual(['GitHub PR']);
    expect(merged.laterPageError).toBe(true);
  });

  it('reports a later-page failure without blanking the loaded rows', () => {
    const merged = mergeProviderInboxSources([
      source({
        platform: 'github',
        rows: githubRows,
        error: new Error('page 2'),
        hasLoadedPages: true,
      }),
    ]);
    expect(merged.firstPageErrorState).toBeNull();
    expect(merged.laterPageError).toBe(true);
    expect(merged.items).toHaveLength(1);
  });

  it('has a next page while any provider still has one', () => {
    expect(
      mergeProviderInboxSources([
        source({ platform: 'github' }),
        source({ platform: 'gitlab', hasNextPage: true }),
      ]).hasNextPage
    ).toBe(true);
  });
});

describe('per-provider pagination inputs', () => {
  it('sends no organization for a personal GitLab inbox and caps at 20 pages', () => {
    const { trpc } = makeTrpc();
    const options = loose(
      buildGitLabInboxQueryOptions(trpc, { enabled: true, organizationId: null })
    );
    expect(options.input).toEqual({ platform: 'gitlab' });
    expect(options.enabled).toBe(true);
    expect(options.maxPages).toBe(20);
    expect(options.getNextPageParam({ nextCursor: 'gl-2' })).toBe('gl-2');
    expect(options.getNextPageParam({ nextCursor: null })).toBeUndefined();
  });

  it('sends the selected organization for an org GitLab inbox', () => {
    const { trpc } = makeTrpc();
    expect(
      loose(buildGitLabInboxQueryOptions(trpc, { enabled: true, organizationId: 'org-1' })).input
    ).toEqual({ platform: 'gitlab', organizationId: 'org-1' });
  });

  it('never queries Bitbucket without an organization', () => {
    const { trpc } = makeTrpc();
    expect(
      loose(buildBitbucketInboxQueryOptions(trpc, { enabled: true, organizationId: null })).enabled
    ).toBe(false);
    const ready = loose(
      buildBitbucketInboxQueryOptions(trpc, { enabled: true, organizationId: 'org-1' })
    );
    expect(ready.enabled).toBe(true);
    expect(ready.input).toEqual({ platform: 'bitbucket', organizationId: 'org-1' });
  });

  it('keeps each provider on its own cursor', () => {
    const { trpc, infiniteQueryOptions } = makeTrpc();
    buildGitLabInboxQueryOptions(trpc, { enabled: true, organizationId: null });
    buildBitbucketInboxQueryOptions(trpc, { enabled: true, organizationId: 'org-1' });
    const inputs = infiniteQueryOptions.mock.calls.map(call => call[0]);
    expect(inputs).toEqual([
      { platform: 'gitlab' },
      { platform: 'bitbucket', organizationId: 'org-1' },
    ]);
  });
});

describe('inboxRetryAction', () => {
  it('leaves a healthy provider alone so its loaded pages are not re-fetched', () => {
    expect(inboxRetryAction(source({ rows: githubRows }))).toBe('none');
  });

  it("advances the failing provider's own cursor when a LATER page failed", () => {
    expect(inboxRetryAction(source({ error: new Error('page 2'), hasLoadedPages: true }))).toBe(
      'fetch-next-page'
    );
  });

  it('refetches the first page when the FIRST page failed', () => {
    // react-query reports `hasNextPage: false` while `data` is undefined, so
    // there is no cursor to advance — `fetchNextPage` would be a dead button.
    expect(inboxRetryAction(source({ error: new Error('boom'), hasLoadedPages: false }))).toBe(
      'refetch'
    );
  });

  it('never touches a provider the user has not connected', () => {
    expect(
      inboxRetryAction(source({ enabled: false, error: new Error('boom'), hasLoadedPages: false }))
    ).toBe('none');
  });

  it('does not stack a second call on an in-flight page', () => {
    expect(
      inboxRetryAction(
        source({ error: new Error('page 2'), hasLoadedPages: true, isFetchingNextPage: true })
      )
    ).toBe('none');
  });
});

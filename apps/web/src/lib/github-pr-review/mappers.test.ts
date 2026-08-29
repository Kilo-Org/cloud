import {
  buildChecksResult,
  buildFilesPage,
  buildInboxResult,
  buildOverviewDto,
  buildReviewThreadsResult,
  sliceFileLines,
  type PullRequestRestData,
} from './mappers';
import {
  FILES_MAX_PAGES,
  type NormalizedGitHubPrReviewInboxItem,
  type NormalizedGitHubPrReviewOverview,
} from './dtos';

describe('buildOverviewDto', () => {
  const basePr = {
    number: 12,
    title: 'Fix the flux capacitor',
    body: 'It was broken',
    user: { login: 'octocat', avatar_url: 'https://avatars.example/octocat' },
    state: 'open' as const,
    draft: false,
    base: { ref: 'main', repo: { full_name: 'kilo/flux' } },
    head: { ref: 'feature/fix', sha: 'abc123', repo: { full_name: 'kilo/flux' } },
    node_id: 'PR_node',
    commits: 3,
    changed_files: 5,
    additions: 100,
    deletions: 20,
    mergeable: true,
    mergeable_state: 'clean',
    auto_merge: { merge_method: 'squash' },
  };

  it('returns overview DTO with all required fields populated', () => {
    const dto = buildOverviewDto({
      pr: basePr,
      repo: {
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: true,
        allow_auto_merge: true,
        delete_branch_on_merge: true,
        allow_update_branch: true,
        permissions: { push: true, admin: false },
      },
      graphQl: {
        repository: { pullRequest: { reviewDecision: 'APPROVED' } },
        viewer: { login: 'octocat' },
      },
      viewer: { login: 'octocat' },
    });
    expect(dto.title).toBe('Fix the flux capacitor');
    expect(dto.state).toBe('open');
    expect(dto.draft).toBe(false);
    expect(dto.reviewDecision).toBe('APPROVED');
    expect(dto.autoMerge).toEqual({ method: 'squash' });
    expect(dto.isCrossRepo).toBe(false);
    expect(dto.headRepoFullName).toBe('kilo/flux');
    expect(dto.repo.viewerCanPush).toBe(true);
    expect(dto.repo.viewerCanAdmin).toBe(false);
    expect(dto.repo.viewerLogin).toBe('octocat');
  });

  it('maps merged PR to "merged" state regardless of GitHub state', () => {
    const dto = buildOverviewDto({
      pr: { ...basePr, merged: true, state: 'closed' },
      repo: {},
      graphQl: null,
      viewer: null,
    });
    expect(dto.state).toBe('merged');
  });

  it('flags cross-repo PRs when head and base differ', () => {
    const dto = buildOverviewDto({
      pr: {
        ...basePr,
        head: { ref: 'feature/fix', sha: 'abc123', repo: { full_name: 'octocat/flux' } },
      },
      repo: {},
      graphQl: null,
      viewer: null,
    });
    expect(dto.isCrossRepo).toBe(true);
    expect(dto.headRepoFullName).toBe('octocat/flux');
  });

  it('handles missing author and reviewDecision', () => {
    const dto = buildOverviewDto({
      pr: { ...basePr, user: null },
      repo: {},
      graphQl: { repository: { pullRequest: null }, viewer: null },
      viewer: null,
    });
    expect(dto.author).toBeNull();
    expect(dto.reviewDecision).toBeNull();
    expect(dto.repo.viewerLogin).toBeNull();
    expect(dto.repo).toEqual({
      allowMergeCommit: false,
      allowSquashMerge: false,
      allowRebaseMerge: false,
      allowAutoMerge: false,
      deleteBranchOnMerge: false,
      allowUpdateBranch: false,
      viewerCanPush: false,
      viewerCanAdmin: false,
      viewerLogin: null,
    });
  });

  function contextFor(changes: Partial<PullRequestRestData> = {}) {
    const dto: NormalizedGitHubPrReviewOverview = buildOverviewDto({
      pr: { ...basePr, ...changes },
      repo: {},
      graphQl: null,
      viewer: null,
    });
    return { dto, context: dto.context };
  }

  it('retains the known revision and unavailable additions for old REST payloads', () => {
    const { dto, context } = contextFor({
      draft: undefined,
      mergeable_state: undefined,
      auto_merge: undefined,
      body: null,
    });
    expect(dto).toMatchObject({
      draft: false,
      mergeableState: null,
      autoMerge: null,
      bodyMarkdown: null,
    });
    expect(context.revision).toEqual({
      prNodeId: 'PR_node',
      number: 12,
      headSha: 'abc123',
      baseRepoFullName: 'kilo/flux',
      baseRef: 'main',
      baseSha: null,
    });
    expect(context.lifecycle.source).toMatchObject({
      availability: 'unavailable',
      reason: 'not-requested',
    });
    expect(context.merger.identity).toBeNull();
    expect(context.queue.membership.state).toBe('unknown');
    expect(context.checks.source.availability).toBe('unavailable');
  });

  it('maps REST dates, merger, labels, assignees, requested users, and teams without extra reads', () => {
    const person = {
      node_id: 'U_1',
      login: 'octocat',
      name: null,
      avatar_url: 'invalid',
      type: 'Bot',
    };
    const { dto, context } = contextFor({
      state: 'closed',
      merged: true,
      base: { ...basePr.base, sha: 'base123' },
      created_at: '2026-03-08T01:30:00-05:00',
      updated_at: '2026-03-08T03:30:00-04:00',
      closed_at: '2026-03-09T00:00:00Z',
      merged_at: '2026-03-09T00:01:00Z',
      merged_by: { ...person, name: 'Octo Cat' },
      labels: [{ node_id: 'L_1', name: 'long label', color: null }],
      assignees: [person, null],
      requested_reviewers: [person, null],
      requested_teams: [{ node_id: 'T_1', name: 'Core team', slug: 'core' }],
    });
    expect(dto.state).toBe('merged');
    expect(dto.autoMerge).toEqual({ method: 'squash' });
    expect(context.revision.baseSha).toBe('base123');
    expect(context.lifecycle).toMatchObject({
      source: { availability: 'available' },
      openedAt: '2026-03-08T01:30:00-05:00',
      updatedAt: '2026-03-08T03:30:00-04:00',
      closedAt: '2026-03-09T00:00:00Z',
      mergedAt: '2026-03-09T00:01:00Z',
    });
    expect(context.merger.identity).toMatchObject({
      id: 'U_1',
      login: 'octocat',
      name: 'Octo Cat',
      avatarUrl: null,
    });
    expect(context.labels.items).toEqual([{ id: 'L_1', name: 'long label', color: null }]);
    expect(context.assignees.items).toEqual([
      {
        id: 'U_1',
        kind: 'Bot',
        login: 'octocat',
        name: null,
        avatarUrl: null,
        url: null,
        teamSlug: null,
      },
      null,
    ]);
    expect(context.reviewRequests.items).toEqual([
      { id: null, reviewer: context.assignees.items[0] },
      { id: null, reviewer: null },
      {
        id: null,
        reviewer: {
          id: 'T_1',
          kind: 'Team',
          login: null,
          name: 'Core team',
          avatarUrl: null,
          url: null,
          teamSlug: 'core',
        },
      },
    ]);
    expect(context.reviewRequests).toMatchObject({
      knownCount: 3,
      completeness: 'unknown',
      totalCount: null,
      source: { availability: 'partial', provenance: ['rest.pullRequest'] },
    });
    expect(context.queue.membership.state).toBe('unknown');
  });

  it.each([
    { value: undefined, availability: 'unavailable' },
    { value: null, availability: 'unavailable' },
    { value: [], availability: 'partial' },
  ])(
    'never calls embedded or missing REST collections complete: $availability/$value',
    ({ value, availability }) => {
      const { context } = contextFor({
        labels: value,
        assignees: value,
        requested_reviewers: value,
        requested_teams: value,
      });
      for (const collection of [context.labels, context.assignees, context.reviewRequests]) {
        expect(collection).toMatchObject({
          items: [],
          knownCount: 0,
          completeness: 'unknown',
          totalCount: null,
          hasNextPage: null,
          source: { availability },
        });
      }
    }
  );

  // A reopened REST PR also has state=open and closed_at=null.
  it.each(['open', 'closed'] as const)(
    'preserves nullable lifecycle events for an unmerged %s PR',
    state => {
      const closedAt = state === 'closed' ? '2026-03-09T00:00:00Z' : null;
      const { dto, context } = contextFor({
        state,
        merged: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-03-09T00:00:00Z',
        closed_at: closedAt,
        merged_at: null,
        merged_by: null,
      });
      expect(dto.state).toBe(state);
      expect(context.lifecycle).toMatchObject({
        source: { availability: 'available' },
        closedAt,
        mergedAt: null,
      });
      expect(context.merger).toMatchObject({
        source: { availability: 'available' },
        identity: null,
      });
    }
  );

  it.each([undefined, null, 'invalid', '2026-02-30T00:00:00Z'])(
    'never substitutes another event time for %s',
    invalid => {
      const { context } = contextFor({
        state: 'closed',
        merged: true,
        created_at: invalid,
        closed_at: invalid,
        updated_at: '2026-03-09T00:00:00Z',
        merged_at: '2026-03-09T00:01:00Z',
      });
      expect(context.lifecycle).toMatchObject({
        source: { availability: 'partial', retryable: true },
        openedAt: null,
        closedAt: null,
        updatedAt: '2026-03-09T00:00:00Z',
        mergedAt: '2026-03-09T00:01:00Z',
      });
    }
  );

  it('preserves merged state when the merger and merge time are unavailable', () => {
    const { dto, context } = contextFor({
      state: 'closed',
      merged: true,
      merged_by: null,
      merged_at: 'invalid',
      closed_at: '2026-03-09T00:00:00Z',
    });
    expect(dto.state).toBe('merged');
    expect(context.lifecycle).toMatchObject({ mergedAt: null, closedAt: '2026-03-09T00:00:00Z' });
    expect(context.merger).toMatchObject({
      source: { availability: 'unavailable', retryable: false },
      identity: null,
    });
  });
});

describe('buildInboxResult', () => {
  it('normalizes missing display names while retaining author identity and pagination', () => {
    const result = buildInboxResult({
      nodes: [
        {
          number: 12,
          title: 'Fix',
          isDraft: true,
          updatedAt: '2026-03-09T00:00:00Z',
          author: { login: 'octocat', avatarUrl: null },
          repository: { name: 'flux', owner: { login: 'kilo' } },
        },
      ],
      pageInfo: { hasNextPage: true, endCursor: 'next' },
    }) satisfies { items: NormalizedGitHubPrReviewInboxItem[] };
    expect(result).toEqual({
      items: [
        {
          owner: 'kilo',
          repo: 'flux',
          number: 12,
          title: 'Fix',
          isDraft: true,
          updatedAt: '2026-03-09T00:00:00Z',
          author: { login: 'octocat', avatarUrl: null },
          authorDisplayName: null,
        },
      ],
      nextCursor: 'next',
    });
  });
});

describe('buildChecksResult', () => {
  it('merges check runs and dedupes commit statuses to the latest per context', () => {
    const result = buildChecksResult({
      checkRuns: [
        {
          name: 'ci',
          status: 'completed',
          conclusion: 'success',
          details_url: 'https://example.com/a',
          app: { name: 'GitHub Actions' },
        },
      ],
      commitStatuses: [
        {
          context: 'codecov',
          state: 'success',
          target_url: 'https://codecov.example/r1',
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          context: 'codecov',
          state: 'failure',
          target_url: 'https://codecov.example/r2',
          updated_at: '2026-01-02T00:00:00Z',
        },
        { context: 'lint', state: 'success', target_url: null, updated_at: null },
      ],
    });
    expect(result.checkRuns).toHaveLength(3);
    const codecov = result.checkRuns.find(c => c.name === 'codecov');
    expect(codecov?.conclusion).toBe('failure');
    expect(codecov?.detailsUrl).toBe('https://codecov.example/r2');
    expect(result.rollup.total).toBe(3);
    expect(result.rollup.success).toBe(2);
    expect(result.rollup.failure).toBe(1);
  });

  it('counts pending commit statuses and in-progress/null check runs in the pending bucket', () => {
    const result = buildChecksResult({
      checkRuns: [
        { name: 'build', status: 'in_progress', conclusion: null },
        { name: 'lint', status: 'completed', conclusion: null },
        { name: 'test', status: 'completed', conclusion: 'success' },
      ],
      commitStatuses: [
        { context: 'deploy', state: 'pending', target_url: null, updated_at: null },
        { context: 'coverage', state: 'success', target_url: null, updated_at: null },
      ],
    });
    // 3 check runs + 2 statuses = 5, and every one lands in exactly one bucket.
    expect(result.rollup.total).toBe(5);
    expect(result.rollup.success).toBe(2); // test + coverage
    expect(result.rollup.failure).toBe(0);
    expect(result.rollup.skipped).toBe(0);
    // build(in_progress) + lint(completed/null) + deploy(pending) = 3
    expect(result.rollup.pending).toBe(3);
    expect(
      result.rollup.success + result.rollup.failure + result.rollup.pending + result.rollup.skipped
    ).toBe(result.rollup.total);
  });
});

describe('buildFilesPage', () => {
  const makeFile = (i: number) => ({
    filename: `src/file${i}.ts`,
    status: 'modified',
    additions: 1,
    deletions: 0,
  });

  it('returns nextCursor null on a short page even when below the cap', () => {
    const result = buildFilesPage({ page: 1, perPage: 50, rawFiles: [makeFile(0), makeFile(1)] });
    expect(result.files).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it('returns nextCursor on a full page below the cap', () => {
    const raw = Array.from({ length: 50 }, (_, i) => makeFile(i));
    const result = buildFilesPage({ page: 1, perPage: 50, rawFiles: raw });
    expect(result.nextCursor).toBe(2);
  });

  it('clamps to FILES_MAX_PAGES and returns null nextCursor at the cap', () => {
    const raw = Array.from({ length: 50 }, (_, i) => makeFile(i));
    const result = buildFilesPage({ page: FILES_MAX_PAGES, perPage: 50, rawFiles: raw });
    expect(result.nextCursor).toBeNull();
  });

  it('returns nextCursor at page 59 when full', () => {
    const raw = Array.from({ length: 50 }, (_, i) => makeFile(i));
    const result = buildFilesPage({ page: 59, perPage: 50, rawFiles: raw });
    expect(result.nextCursor).toBe(60);
  });

  it('returns nextCursor at page 60 when full (cap reached → null)', () => {
    const raw = Array.from({ length: 50 }, (_, i) => makeFile(i));
    const result = buildFilesPage({ page: 60, perPage: 50, rawFiles: raw });
    expect(result.nextCursor).toBeNull();
  });

  it('flags patchMissing when GitHub omits the patch', () => {
    const result = buildFilesPage({
      page: 1,
      perPage: 50,
      rawFiles: [{ filename: 'big.bin', status: 'modified', additions: 0, deletions: 0 }],
    });
    expect(result.files[0]?.patchMissing).toBe(true);
    expect(result.files[0]?.patch).toBeNull();
  });

  it('preserves previousPath on renames', () => {
    const result = buildFilesPage({
      page: 1,
      perPage: 50,
      rawFiles: [
        {
          filename: 'new.ts',
          previous_filename: 'old.ts',
          status: 'renamed',
          additions: 1,
          deletions: 1,
        },
      ],
    });
    expect(result.files[0]?.previousPath).toBe('old.ts');
  });
});

describe('sliceFileLines', () => {
  const content = 'a\nb\nc\nd\ne';

  it('returns the requested slice and totalLines', () => {
    const result = sliceFileLines({ rawContent: content, startLine: 2, endLine: 4 });
    expect(result.lines).toEqual(['b', 'c', 'd']);
    expect(result.totalLines).toBe(5);
  });

  it('caps the returned slice at 500 lines', () => {
    const huge = Array.from({ length: 1000 }, (_, i) => `line${i}`).join('\n');
    const result = sliceFileLines({ rawContent: huge, startLine: 1, endLine: 10_000 });
    expect(result.lines).toHaveLength(500);
  });
});

describe('buildReviewThreadsResult', () => {
  it('maps a thread with file-level subject and null line', () => {
    const result = buildReviewThreadsResult({
      page: 1,
      hasNextPage: false,
      endCursor: null,
      conversation: [],
      threads: [
        {
          id: 'thread-1',
          isResolved: false,
          isOutdated: false,
          subjectType: 'FILE',
          path: 'src/file.ts',
          diffSide: 'RIGHT',
          comments: [
            {
              databaseId: 42,
              id: 'comment-node-1',
              author: { login: 'octocat', avatarUrl: 'https://avatars.example/octocat' },
              body: 'LGTM',
              createdAt: '2026-01-01T00:00:00Z',
              reactions: [{ content: '+1', count: 2, viewerHasReacted: false }],
            },
          ],
        },
      ],
    });
    expect(result.threads[0]?.subjectType).toBe('FILE');
    expect(result.threads[0]?.line).toBeNull();
    expect(result.threads[0]?.path).toBe('src/file.ts');
    expect(result.threads[0]?.comments[0]?.reactions[0]?.count).toBe(2);
    expect(result.conversation).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  it('maps an outdated thread anchored by originalLine/originalStartLine', () => {
    const result = buildReviewThreadsResult({
      page: 1,
      hasNextPage: false,
      endCursor: null,
      conversation: [],
      threads: [
        {
          id: 'thread-2',
          isResolved: true,
          isOutdated: true,
          subjectType: 'LINE',
          path: 'src/old.ts',
          line: 10,
          startLine: 9,
          originalLine: 20,
          originalStartLine: 19,
          diffSide: 'LEFT',
          comments: [],
        },
      ],
    });
    expect(result.threads[0]?.isOutdated).toBe(true);
    expect(result.threads[0]?.originalLine).toBe(20);
    expect(result.threads[0]?.originalStartLine).toBe(19);
    expect(result.threads[0]?.diffSide).toBe('LEFT');
  });

  it('tolerates deleted-author comments (author = null)', () => {
    const result = buildReviewThreadsResult({
      page: 1,
      hasNextPage: false,
      endCursor: null,
      conversation: [],
      threads: [
        {
          id: 'thread-3',
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              databaseId: 7,
              id: 'comment-node-7',
              author: null,
              body: 'comment from deleted user',
              createdAt: '2026-01-01T00:00:00Z',
              reactions: [],
            },
          ],
        },
      ],
    });
    expect(result.threads[0]?.comments[0]?.author).toBeNull();
  });

  it('exposes nextCursor when GitHub reports hasNextPage and an endCursor', () => {
    const result = buildReviewThreadsResult({
      page: 1,
      hasNextPage: true,
      endCursor: 'Y3Vyc29yOnYyOpHOAAAAAA==',
      conversation: [],
      threads: [],
    });
    expect(result.nextCursor).toBe('Y3Vyc29yOnYyOpHOAAAAAA==');
  });

  it('folds a multi-page comment list into a single complete thread', () => {
    // Mapper is invoked per-thread with the already-aggregated comment list;
    // the procedure is responsible for the per-thread paginated fetch.
    const result = buildReviewThreadsResult({
      page: 1,
      hasNextPage: false,
      endCursor: null,
      conversation: [],
      threads: [
        {
          id: 'thread-4',
          isResolved: false,
          isOutdated: false,
          comments: Array.from({ length: 120 }, (_, i) => ({
            databaseId: 1000 + i,
            id: `c-${i}`,
            author: null,
            body: `comment ${i}`,
            createdAt: '2026-01-01T00:00:00Z',
            reactions: [],
          })),
        },
      ],
    });
    expect(result.threads[0]?.comments).toHaveLength(120);
  });

  it('maps diffHunk through; empty string and absent become null', () => {
    const withHunk = buildReviewThreadsResult({
      page: 1,
      hasNextPage: false,
      endCursor: null,
      conversation: [],
      threads: [
        {
          id: 'thread-hunk',
          isResolved: false,
          isOutdated: false,
          diffHunk: '@@ -1,3 +1,4 @@\n line',
          comments: [],
        },
      ],
    });
    expect(withHunk.threads[0]?.diffHunk).toBe('@@ -1,3 +1,4 @@\n line');

    const emptyHunk = buildReviewThreadsResult({
      page: 1,
      hasNextPage: false,
      endCursor: null,
      conversation: [],
      threads: [
        {
          id: 'thread-empty-hunk',
          isResolved: false,
          isOutdated: false,
          diffHunk: '',
          comments: [],
        },
      ],
    });
    expect(emptyHunk.threads[0]?.diffHunk).toBeNull();

    const absentHunk = buildReviewThreadsResult({
      page: 1,
      hasNextPage: false,
      endCursor: null,
      conversation: [],
      threads: [
        {
          id: 'thread-no-hunk',
          isResolved: false,
          isOutdated: false,
          comments: [],
        },
      ],
    });
    expect(absentHunk.threads[0]?.diffHunk).toBeNull();
  });

  it('maps conversation comments through the same DTO shape as thread comments', () => {
    const result = buildReviewThreadsResult({
      page: 1,
      hasNextPage: false,
      endCursor: null,
      threads: [],
      conversation: [
        {
          databaseId: 99,
          id: 'IC_99',
          author: { login: 'alice', avatarUrl: 'https://avatars.example/alice' },
          body: 'top-level note',
          createdAt: '2026-02-01T00:00:00Z',
          reactions: [{ content: 'HEART', count: 1, viewerHasReacted: true }],
        },
      ],
    });
    expect(result.conversation).toEqual([
      {
        commentId: 99,
        nodeId: 'IC_99',
        author: { login: 'alice', avatarUrl: 'https://avatars.example/alice' },
        bodyMarkdown: 'top-level note',
        createdAt: '2026-02-01T00:00:00Z',
        reactions: [{ content: 'HEART', count: 1, viewerHasReacted: true }],
      },
    ]);
  });
});

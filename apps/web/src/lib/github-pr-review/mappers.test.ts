import {
  buildChecksResult,
  buildFilesPage,
  buildOverviewDto,
  buildReviewThreadsResult,
  sliceFileLines,
} from './mappers';
import { FILES_MAX_PAGES } from './dtos';

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
    expect(result.nextCursor).toBeNull();
  });

  it('maps an outdated thread anchored by originalLine/originalStartLine', () => {
    const result = buildReviewThreadsResult({
      page: 1,
      hasNextPage: false,
      endCursor: null,
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
});

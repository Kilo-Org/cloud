/**
 * Fixture data for the local mock GitHub API used by the PR-review surfaces.
 *
 * One mergeable pull request (renders the merge sheet) and one whose
 * mergeability GitHub has not reported yet (renders the blocked reasons list),
 * so both branches of the merge section can be exercised without a provider
 * connection.
 */

export const FIXTURE_OWNER = 'acme';
export const FIXTURE_REPO = 'widgets';

/** The repository settings the merge sheet reads. */
export function repoFixture() {
  return {
    id: 1001,
    name: FIXTURE_REPO,
    full_name: `${FIXTURE_OWNER}/${FIXTURE_REPO}`,
    private: false,
    default_branch: 'main',
    allow_merge_commit: true,
    allow_squash_merge: true,
    allow_rebase_merge: true,
    allow_auto_merge: true,
    allow_update_branch: true,
    delete_branch_on_merge: true,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

/**
 * Pull request fixtures by number. A `null` mergeable state never reaches this
 * mock: GitHub answers `clean` with `mergeable: false` while a state is still
 * being computed, which is the shape the blocked reasons list reads.
 */
export const PULL_REQUEST_FIXTURES = [
  { number: 1, title: 'Add merge sheet copy', mergeable: true, mergeableState: 'clean' },
  {
    number: 2,
    title: 'Add merge settings copy',
    mergeable: false,
    mergeableState: 'clean',
  },
] as const;

export function pullRequestFixture(number: number) {
  const fixture = PULL_REQUEST_FIXTURES.find(entry => entry.number === number);
  if (!fixture) {
    return null;
  }
  return {
    number: fixture.number,
    node_id: `PR_node_${fixture.number}`,
    title: fixture.title,
    body: 'Fixture pull request for the merge surface.',
    state: 'open',
    draft: false,
    merged: false,
    mergeable: fixture.mergeable,
    mergeable_state: fixture.mergeableState,
    auto_merge: null,
    user: { login: 'octocat', avatar_url: 'https://avatars.example.com/u/1' },
    labels: [{ name: 'copy', color: '0e8a16' }],
    assignees: [],
    base: {
      ref: 'main',
      repo: { id: 1001, full_name: `${FIXTURE_OWNER}/${FIXTURE_REPO}` },
    },
    head: {
      ref: `feature/pr-${fixture.number}`,
      sha: `${fixture.number}`.padStart(40, 'b'),
      repo: { id: 1001, full_name: `${FIXTURE_OWNER}/${FIXTURE_REPO}` },
    },
    commits: 3,
    changed_files: PULL_REQUEST_FILE_COUNT,
    ...pullRequestFileTotals(),
    comments: 0,
    review_comments: 0,
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-02T10:00:00Z',
    closed_at: null,
    merged_at: null,
    merged_by: null,
  };
}

/**
 * The pull-request files: more than one REST page, and one row per status the
 * Files tab labels, so the list, the status chips and the pagination row all
 * have something to render. The first page carries every labelled status; the
 * rest fill the second page so `nextCursor` is not null.
 */
export const PULL_REQUEST_FILE_COUNT = 60;

const LABELLED_FILES = [
  { filename: 'src/feature/alpha.ts', status: 'modified' },
  { filename: 'src/feature/beta.ts', status: 'changed' },
  { filename: 'src/feature/gamma.ts', status: 'renamed', previous: 'src/feature/gamma-old.ts' },
  { filename: 'src/feature/delta.ts', status: 'copied' },
  { filename: 'src/feature/epsilon.ts', status: 'added' },
  { filename: 'src/feature/zeta.ts', status: 'removed' },
] as const;

const FILE_PATCH = [
  '@@ -1,2 +1,2 @@',
  ' const context = 1;',
  '-const before = 2;',
  '+const after = 2;',
];

export function pullRequestFilesFixture() {
  return Array.from({ length: PULL_REQUEST_FILE_COUNT }, (_unused, index) => {
    const labelled = LABELLED_FILES[index];
    const filename = labelled?.filename ?? `src/generated/file-${index}.ts`;
    const status = labelled?.status ?? 'modified';
    // A file that only arrived has no deleted lines, and one that only left has
    // no added lines; every other status changes one line each way.
    const additions = status === 'removed' ? 0 : 1;
    const deletions = status === 'added' ? 0 : 1;
    return {
      sha: `${index}`.padStart(40, 'd'),
      filename,
      previous_filename:
        labelled !== undefined && 'previous' in labelled ? labelled.previous : null,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      patch: FILE_PATCH.join('\n'),
    };
  });
}

/** The line totals the pull-request fixture reports for its file list. */
export function pullRequestFileTotals() {
  return pullRequestFilesFixture().reduce(
    (totals, file) => ({
      additions: totals.additions + file.additions,
      deletions: totals.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 }
  );
}

/** The overview enrichment query: review decision, reviewers, viewer. */
export function overviewGraphQlFixture() {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewDecision: null,
          latestReviews: { nodes: [] },
          reviewRequests: { nodes: [] },
          closingIssuesReferences: { nodes: [] },
        },
      },
      viewer: { login: 'octocat' },
    },
  };
}

/** An empty review-thread page, so the discussion tab renders its empty state. */
export function reviewThreadsGraphQlFixture() {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    },
  };
}

/** An empty conversation-comment page. */
export function conversationGraphQlFixture() {
  return {
    data: {
      repository: {
        pullRequest: {
          comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      },
    },
  };
}

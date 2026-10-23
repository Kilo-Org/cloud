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
    changed_files: 2,
    additions: 12,
    deletions: 4,
    comments: 0,
    review_comments: 0,
    created_at: '2026-10-01T10:00:00Z',
    updated_at: '2026-10-02T10:00:00Z',
    closed_at: null,
    merged_at: null,
    merged_by: null,
  };
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

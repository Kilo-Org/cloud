import type { Octokit } from '@octokit/rest';
import {
  createContextReadBudget,
  readPullRequestContext,
  PR_CONTEXT_REVISION_QUERY,
} from './context-reader';
import { PR_CONTEXT_REVIEW_QUERIES } from './context-reviews';
import { PR_CONTEXT_PEOPLE_QUERIES } from './context-people';
import { GitHubPrReviewContextSchema } from './context-dtos';
import type { PullRequestRestData } from './mappers';

const fields = ['latestOpinionatedReviews', 'latestReviews'] as const;
type Field = (typeof fields)[number];
const submittedAt = '2026-08-25T12:00:00+02:00';
const later = '2026-08-26T10:00:00Z';
const person = (id = 'U') => ({
  __typename: 'User',
  id,
  login: 'same-login',
  name: null,
  avatarUrl: null,
  url: null,
});
const connection = (nodes: unknown[], totalCount = nodes.length, next: string | null = null) => ({
  nodes,
  totalCount,
  pageInfo: { hasNextPage: next !== null, endCursor: next },
});
const review = (state = 'APPROVED', id = 'decision', patch: Record<string, unknown> = {}) => ({
  id,
  state,
  author: person(),
  submittedAt,
  commit: { oid: 'reviewed-commit' },
  onBehalfOf: connection([]),
  createdAt: later,
  updatedAt: later,
  ...patch,
});
const page = (
  field: string,
  nodes: unknown[],
  totalCount = nodes.length,
  next: string | null = null,
  errors?: unknown[]
) => ({
  data: {
    data: { repository: { pullRequest: { [field]: connection(nodes, totalCount, next) } } },
    errors,
  },
});
const revision = {
  prNodeId: 'PR_1',
  number: 1,
  headSha: 'head',
  baseRef: 'main',
  baseSha: 'base',
  baseRepoFullName: 'o/r',
};
const pr: PullRequestRestData = {
  node_id: 'PR_1',
  number: 1,
  title: 'PR',
  body: null,
  user: null,
  state: 'open',
  head: { ref: 'feature', sha: 'head' },
  base: { ref: 'main', sha: 'base', repo: { full_name: 'o/r' } },
  commits: 1,
  changed_files: 1,
  additions: 1,
  deletions: 0,
  mergeable: null,
};
let budget: ReturnType<typeof createContextReadBudget>;
beforeEach(() => {
  jest.useFakeTimers();
  budget = createContextReadBudget();
});
afterEach(() => {
  budget.close();
  jest.useRealTimers();
  jest.restoreAllMocks();
});
async function run(
  serve: (field: Field, after: string | null, signal: AbortSignal) => unknown,
  requests: unknown[] = [],
  finalHead = 'head'
) {
  const octokit = {
    pulls: { get: async () => ({ data: pr }) },
    request: async (
      _route: string,
      body: { query: string; variables: { after: string | null }; request: { signal: AbortSignal } }
    ) => {
      if (body.query === PR_CONTEXT_REVISION_QUERY)
        return {
          data: {
            data: {
              repository: {
                pullRequest: {
                  id: 'PR_1',
                  number: 1,
                  headRefOid: finalHead,
                  baseRefName: 'main',
                  baseRefOid: 'base',
                  baseRepository: { nameWithOwner: 'o/r' },
                },
              },
            },
          },
        };
      const field = fields.find(field => PR_CONTEXT_REVIEW_QUERIES[field] === body.query);
      if (field) return serve(field, body.variables.after, body.request.signal);
      const people = Object.entries(PR_CONTEXT_PEOPLE_QUERIES).find(
        ([, query]) => query === body.query
      )?.[0];
      if (!people) throw new Error('Unexpected request');
      return page(people, people === 'reviewRequests' ? requests : []);
    },
  } as unknown as Octokit;
  return GitHubPrReviewContextSchema.parse(
    await readPullRequestContext(
      octokit,
      {
        owner: 'o',
        repo: 'r',
        number: 1,
        expectedRevision: revision,
      },
      budget
    )
  );
}

it('keeps complete empty reviews separate from outstanding requests', async () => {
  const result = await run(
    field => page(field, []),
    [{ id: 'request', requestedReviewer: person() }]
  );
  for (const reviews of [result.reviewDecisions, result.reviewActivity])
    expect(reviews).toMatchObject({
      items: [],
      completeness: 'complete',
      knownCount: 0,
      totalCount: 0,
      source: { availability: 'available' },
    });
  expect(result.reviewRequests.items).toHaveLength(1);
});

it('traverses both review connections beyond 100 with independent cursors', async () => {
  const result = await run((field, after) => {
    if (after !== null && after !== `${field}-next`) throw new Error('Wrong review cursor');
    const count = field === 'latestOpinionatedReviews' ? 101 : 102;
    return page(
      field,
      Array.from({ length: after ? count - 100 : 100 }, (_, n) => {
        const i = n + (after ? 100 : 0);
        return review(i === 101 ? 'COMMENTED' : 'APPROVED', `R${i}`, { author: person(`U${i}`) });
      }),
      count,
      after ? null : `${field}-next`
    );
  });
  expect(result.reviewDecisions).toMatchObject({
    knownCount: 101,
    totalCount: 101,
    completeness: 'complete',
    hasNextPage: false,
    source: {
      availability: 'available',
      retryable: false,
      provenance: ['graphql.latestOpinionatedReviews', 'graphql.latestReviews'],
    },
  });
  expect(result.reviewActivity).toMatchObject({
    knownCount: 102,
    totalCount: 102,
    completeness: 'complete',
    hasNextPage: false,
    source: { availability: 'available', provenance: ['graphql.latestReviews'] },
  });
  expect(result.reviewDecisions.items[100]).toMatchObject({
    id: 'R100',
    actor: { id: 'U100' },
    state: 'APPROVED',
    submittedAt,
    commitSha: 'reviewed-commit',
  });
});

it('marks current decisions stale after a head change without erasing submitted activity', async () => {
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  const result = await run(field => page(field, [review()]), [], 'new-head');
  expect(result.reviewDecisions).toMatchObject({
    items: [{ id: 'decision' }],
    completeness: 'unknown',
    source: { availability: 'stale', retryable: true },
  });
  expect(result.reviewActivity).toMatchObject({
    items: [{ id: 'decision', submittedAt }],
    source: { availability: 'available' },
  });
});

describe.each(fields)('%s null-page evidence', field => {
  it.each([
    {
      name: 'timestamp and commit',
      missing: { submittedAt: null, commit: null },
      changed: { submittedAt: later, commit: { oid: 'other-commit' } },
    },
    { name: 'timestamp', missing: { submittedAt: null }, changed: { submittedAt: later } },
    { name: 'commit', missing: { commit: null }, changed: { commit: { oid: 'other-commit' } } },
  ])('keeps $name conflicts unknown across a null observation', async ({ missing, changed }) => {
    const result = await run((other, after) =>
      page(
        other,
        [
          review(
            'APPROVED',
            'decision',
            other !== field || after === 'last' ? changed : after ? missing : {}
          ),
        ],
        1,
        other !== field || after === 'last' ? null : after ? 'last' : 'middle'
      )
    );
    expect(result.reviewDecisions).toMatchObject({
      items: [{ id: 'decision', state: 'UNKNOWN' }],
      knownCount: 1,
      totalCount: null,
      completeness: 'partial',
      source: { availability: 'partial', retryable: true, reason: 'review-inconsistent' },
    });
  });

  it('does not publish comparison values when the final observation is null', async () => {
    const result = await run((other, after) =>
      page(
        other,
        [
          review(
            'APPROVED',
            'decision',
            other !== field || after ? { submittedAt: null, commit: null } : {}
          ),
        ],
        1,
        other === field && !after ? 'last' : null
      )
    );
    for (const reviews of [result.reviewDecisions, result.reviewActivity])
      expect(reviews).toMatchObject({
        items: [{ id: 'decision', state: 'APPROVED', submittedAt: null, commitSha: null }],
        completeness: 'complete',
      });
  });
});

describe.each(fields)('%s final-null cross-connection evidence', nullField => {
  describe.each(fields)('%s completes last', slowField => {
    async function readWithFinalNull(changed: Record<string, unknown>) {
      const pending = run(async (field, after) => {
        if (field === slowField) await new Promise(resolve => setTimeout(resolve, 1));
        return page(
          field,
          [
            review(
              'APPROVED',
              'decision',
              field !== nullField ? changed : after ? { submittedAt: null, commit: null } : {}
            ),
            review('APPROVED', 'sibling', { author: person('sibling') }),
          ],
          2,
          field === nullField && !after ? 'last' : null
        );
      });
      await jest.advanceTimersByTimeAsync(10);
      return pending;
    }

    it.each([
      {
        name: 'timestamp and commit',
        changed: { submittedAt: later, commit: { oid: 'other-commit' } },
      },
      { name: 'timestamp', changed: { submittedAt: later } },
      { name: 'commit', changed: { commit: { oid: 'other-commit' } } },
    ])('keeps $name conflicts unknown without losing siblings', async ({ changed }) => {
      const result = await readWithFinalNull(changed);
      expect(result.reviewDecisions).toMatchObject({
        items: [
          { id: 'decision', state: 'UNKNOWN' },
          { id: 'sibling', state: 'APPROVED', submittedAt, commitSha: 'reviewed-commit' },
        ],
        knownCount: 2,
        totalCount: null,
        completeness: 'partial',
        source: { availability: 'partial', retryable: true, reason: 'review-inconsistent' },
      });
      expect(result.reviewActivity).toMatchObject({
        items: [
          { id: 'decision', state: 'APPROVED' },
          { id: 'sibling', state: 'APPROVED' },
        ],
        completeness: 'complete',
        source: { availability: 'available', retryable: false },
      });
      const nullable =
        nullField === 'latestOpinionatedReviews' ? result.reviewDecisions : result.reviewActivity;
      expect(nullable.items[0]).toMatchObject({ submittedAt: null, commitSha: null });
    });

    it('keeps consistent evidence complete without borrowing final null values', async () => {
      const result = await readWithFinalNull({});
      for (const reviews of [result.reviewDecisions, result.reviewActivity])
        expect(reviews).toMatchObject({
          items: [
            { id: 'decision', state: 'APPROVED' },
            { id: 'sibling', state: 'APPROVED', submittedAt, commitSha: 'reviewed-commit' },
          ],
          knownCount: 2,
          totalCount: 2,
          completeness: 'complete',
          source: { availability: 'available', retryable: false },
        });
      const nullable =
        nullField === 'latestOpinionatedReviews' ? result.reviewDecisions : result.reviewActivity;
      expect(nullable.items[0]).toMatchObject({ submittedAt: null, commitSha: null });
    });
  });
});

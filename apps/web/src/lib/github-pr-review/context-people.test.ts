import type { Octokit } from '@octokit/rest';
import {
  createContextReadBudget,
  readPullRequestContext,
  PR_CONTEXT_REVISION_QUERY,
} from './context-reader';
import { PR_CONTEXT_PEOPLE_QUERIES } from './context-people';
import { GitHubPrReviewContextSchema } from './context-dtos';
import type { PullRequestRestData } from './mappers';

const fields = ['labels', 'assignees', 'reviewRequests'] as const;
type Field = (typeof fields)[number];
const revision = {
  prNodeId: 'PR_1',
  number: 1,
  headSha: 'head',
  baseRepoFullName: 'o/r',
  baseRef: 'main',
  baseSha: 'base',
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
const person = (id: string) => ({
  __typename: 'User',
  id,
  login: 'login',
  name: null,
  avatarUrl: null,
  url: null,
});
const node = (field: Field, index: number) =>
  field === 'labels'
    ? { id: `labels-${index}`, name: 'same name', color: null }
    : field === 'assignees'
      ? person(`assignees-${index}`)
      : { id: `request-${index}`, requestedReviewer: person(`reviewer-${index}`) };
const rest = {
  labels: [
    { node_id: 'labels-0', name: 'old name', color: 'ffffff' },
    { id: 7, name: 'same name' },
  ],
  assignees: [
    { node_id: 'assignees-0', login: 'login', name: 'Known name' },
    { id: 7, login: 'login' },
  ],
  requested_reviewers: [
    { node_id: 'reviewer-0', login: 'login', name: 'Known name' },
    { id: 7, login: 'login' },
  ],
};
function page(
  field: Field,
  nodes: unknown[],
  totalCount = nodes.length,
  next: string | null = null,
  errors?: unknown[]
) {
  return {
    data: {
      data: {
        repository: {
          pullRequest: {
            [field]: {
              nodes,
              totalCount,
              pageInfo: { hasNextPage: next !== null, endCursor: next },
            },
          },
        },
      },
      errors,
    },
  };
}
let budget: ReturnType<typeof createContextReadBudget>;
beforeEach(() => {
  jest.useFakeTimers();
  budget = createContextReadBudget();
});
afterEach(() => {
  budget.close();
  jest.useRealTimers();
});
async function run(
  serve: (field: Field, after: string | null, signal: AbortSignal) => unknown,
  fallback: Partial<PullRequestRestData> = rest,
  requests: string[] = []
) {
  const octokit = {
    pulls: { get: async () => ({ data: { ...pr, ...fallback } }) },
    request: async (
      _route: string,
      body: { query: string; variables: { after: string | null }; request: { signal: AbortSignal } }
    ) => {
      requests.push(body.query);
      if (body.query === PR_CONTEXT_REVISION_QUERY)
        return {
          data: {
            data: {
              repository: {
                pullRequest: {
                  id: 'PR_1',
                  number: 1,
                  headRefOid: 'head',
                  baseRefName: 'main',
                  baseRefOid: 'base',
                  baseRepository: { nameWithOwner: 'o/r' },
                },
              },
            },
          },
        };
      const field = fields.find(field => PR_CONTEXT_PEOPLE_QUERIES[field] === body.query);
      if (!field) throw new Error('Unexpected per-person request');
      return serve(field, body.variables.after, body.request.signal);
    },
  } as unknown as Octokit;
  return GitHubPrReviewContextSchema.parse(
    await readPullRequestContext(
      octokit,
      { owner: 'o', repo: 'r', number: 1, expectedRevision: revision },
      budget
    )
  );
}

it('traverses more than 100 entries independently without per-person requests', async () => {
  const counts = { labels: 101, assignees: 102, reviewRequests: 103 };
  const requests: string[] = [];
  const result = await run(
    (field, after) => {
      if (after !== null && after !== `${field}-next`) throw new Error('Wrong cursor');
      return page(
        field,
        Array.from({ length: after ? counts[field] - 100 : 100 }, (_, i) =>
          node(field, i + (after ? 100 : 0))
        ),
        counts[field],
        after ? null : `${field}-next`
      );
    },
    rest,
    requests
  );
  for (const field of fields) {
    expect(result[field]).toMatchObject({
      knownCount: counts[field],
      totalCount: counts[field],
      completeness: 'complete',
      hasNextPage: false,
      source: { availability: 'available' },
    });
    expect(result[field].items).toHaveLength(counts[field]);
  }
  // Two pages per collection and the final revision read, without identity lookups.
  expect(requests).toHaveLength(7);
});

describe.each(fields)('%s completeness', field => {
  it('replaces fallback membership after a successful empty traversal', async () => {
    expect((await run(other => page(other, [])))[field]).toMatchObject({
      items: [],
      knownCount: 0,
      totalCount: 0,
      completeness: 'complete',
      source: { availability: 'available', retryable: false },
    });
  });

  it.each([
    'repeat',
    'null-node',
    'invalid-node',
    'partial-error',
    'denied-error',
    'pathless-error',
    'count-mismatch',
    'changed-count',
    'missing-page-info',
    'null-source',
    'null-ancestor',
  ])('retains known entries and explicit uncertainty for %s', async defect => {
    let pages = 0;
    const result = await run((other, after) => {
      if (other !== field) return page(other, []);
      if (++pages > 2) throw new Error('Repeated cursor was not stopped');
      if (defect === 'null-source' || defect === 'null-ancestor')
        return {
          data: {
            data: {
              repository: { pullRequest: defect === 'null-source' ? { [field]: null } : null },
            },
          },
        };
      if (defect === 'partial-error' || defect === 'changed-count')
        return page(
          field,
          [node(field, after ? 1 : 0)],
          !after && defect === 'changed-count' ? 3 : 2,
          after ? null : 'next',
          !after && defect === 'partial-error'
            ? [{ type: 'INTERNAL', path: ['repository', 'pullRequest', field, 'nodes', 0] }]
            : undefined
        );
      const response = page(
        field,
        [
          node(field, 0),
          node(field, 1),
          ...(defect === 'null-node' ? [null] : defect === 'invalid-node' ? [{}] : []),
        ],
        ['null-node', 'invalid-node', 'count-mismatch'].includes(defect) ? 3 : 2,
        defect === 'repeat' ? 'same-cursor' : null,
        defect.endsWith('error')
          ? [
              {
                type: defect === 'denied-error' ? 'FORBIDDEN' : 'INTERNAL',
                path:
                  defect === 'pathless-error'
                    ? undefined
                    : ['repository', 'pullRequest', field, 'nodes', 0],
              },
            ]
          : undefined
      );
      if (defect === 'missing-page-info')
        Reflect.deleteProperty(response.data.data.repository.pullRequest[field], 'pageInfo');
      if (after && defect !== 'repeat') throw new Error('Unexpected page');
      return response;
    });
    const reason =
      defect === 'denied-error'
        ? 'graphql-denied'
        : ['partial-error', 'pathless-error', 'null-source', 'null-ancestor'].includes(defect)
          ? 'graphql-incomplete'
          : 'pagination-incomplete';
    expect(result[field]).toMatchObject({
      completeness: 'partial',
      source: { availability: 'partial', retryable: defect !== 'denied-error', reason },
    });
    expect(result[field].items).toHaveLength(
      defect.startsWith('null-') && defect !== 'null-node' ? 2 : 3
    );
    for (const other of fields.filter(other => other !== field))
      expect(result[other].completeness).toBe('complete');
    if (!defect.startsWith('null-') || defect === 'null-node') {
      if (field === 'labels')
        expect(result.labels.items).toEqual([
          { id: 'labels-0', name: 'same name', color: 'ffffff' },
          { id: 'labels-1', name: 'same name', color: null },
          { id: '7', name: 'same name', color: null },
        ]);
      if (field === 'assignees')
        expect(result.assignees.items).toMatchObject([
          { id: 'assignees-0', name: 'Known name' },
          { id: 'assignees-1' },
          { id: '7' },
        ]);
      if (field === 'reviewRequests')
        expect(result.reviewRequests.items).toMatchObject([
          { id: 'request-0', reviewer: { id: 'reviewer-0', name: 'Known name' } },
          { id: 'request-1' },
          { id: null, reviewer: { id: '7' } },
        ]);
    }
  });

  it.each([401, 403, 503])(
    'preserves fallback with the correct retry policy after HTTP %s',
    async status => {
      const result = await run(other => {
        if (other === field) throw { status };
        return page(other, []);
      });
      expect(result[field]).toMatchObject({
        knownCount: 2,
        completeness: 'partial',
        source: { availability: 'partial', retryable: status === 503 },
      });
      const empty = await run(other => {
        if (other === field) throw { status };
        return page(other, []);
      }, {});
      expect(empty[field]).toMatchObject({
        items: [],
        completeness: 'unknown',
        source: {
          availability: status === 503 ? 'unavailable' : 'denied',
          retryable: status === 503,
        },
      });
    }
  );

  it('retains completed pages when the shared deadline aborts a later page', async () => {
    let aborted = false;
    const pending = run((other, after, signal) => {
      if (other !== field) return page(other, []);
      if (!after) return page(field, [node(field, 0)], 2, 'next');
      return new Promise(resolve =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve(page(field, [node(field, 1)], 2));
          },
          { once: true }
        )
      );
    }, {});
    await jest.advanceTimersByTimeAsync(10_000);
    expect((await pending)[field]).toMatchObject({
      knownCount: 1,
      totalCount: 2,
      hasNextPage: true,
      endCursor: 'next',
      completeness: 'partial',
      source: { availability: 'partial', retryable: true, reason: 'deadline' },
    });
    expect(aborted).toBe(true);
  });
});

it.each([null, 'https://avatars.example/supplied.png'])(
  'preserves full text, typed identities, stable fallbacks, and supplied avatar %s',
  async avatarUrl => {
    const long = 'Full display name'.repeat(30);
    const result = await run(field =>
      page(
        field,
        field === 'labels'
          ? [{ id: 'L', name: long }]
          : field === 'assignees'
            ? [
                { ...person('U'), name: long, avatarUrl, url: 'https://github.com/octocat' },
                { ...person('missing-avatar'), avatarUrl: 'invalid' },
              ]
            : [
                ...['User', 'Bot', 'Mannequin'].map((kind, i) => ({
                  id: `R${i}`,
                  requestedReviewer: { ...person(`P${i}`), __typename: kind },
                })),
                {
                  id: 'team',
                  requestedReviewer: {
                    __typename: 'Team',
                    id: 'T',
                    teamName: long,
                    slug: 'core',
                    teamAvatarUrl: avatarUrl,
                    url: 'https://github.com/orgs/o/teams/core',
                  },
                },
                { id: 'missing-1', requestedReviewer: null },
                { id: 'missing-2', requestedReviewer: null },
              ]
      )
    );
    expect(result.labels.items).toEqual([{ id: 'L', name: long, color: null }]);
    expect(result.assignees.items).toMatchObject([
      { id: 'U', name: long, avatarUrl, url: 'https://github.com/octocat' },
      { id: 'missing-avatar', name: null, login: 'login', avatarUrl: null },
    ]);
    expect(result.reviewRequests.items).toMatchObject([
      { id: 'R0', reviewer: { kind: 'User', login: 'login', name: null } },
      { id: 'R1', reviewer: { kind: 'Bot', login: 'login' } },
      { id: 'R2', reviewer: { kind: 'Mannequin', login: 'login' } },
      {
        id: 'team',
        reviewer: {
          kind: 'Team',
          login: null,
          name: long,
          teamSlug: 'core',
          avatarUrl,
          url: 'https://github.com/orgs/o/teams/core',
        },
      },
      { id: 'missing-1', reviewer: { kind: 'Unavailable', id: null } },
      { id: 'missing-2', reviewer: { kind: 'Unavailable', id: null } },
    ]);
    expect(result.reviewDecisions.items).toEqual([]);
    expect(result.reviewRequests.completeness).toBe('complete');
  }
);

import type { Octokit } from '@octokit/rest';
import {
  createContextReadBudget,
  readPullRequestContext,
  PR_CONTEXT_REVISION_QUERY,
} from './context-reader';
import { PR_CONTEXT_ISSUE_QUERIES } from './context-issues';
import { PR_CONTEXT_PEOPLE_QUERIES } from './context-people';
import { PR_CONTEXT_REVIEW_QUERIES } from './context-reviews';
import { GitHubPrReviewContextSchema } from './context-dtos';

const fields = ['closingIssuesReferences', 'timelineItems'] as const;
type Field = (typeof fields)[number];
const prEndpoint = { __typename: 'PullRequest', id: 'PR' };
const title = 'A full issue title '.repeat(30);
const issue = (id = 'I', repository = 'o/r') => ({
  __typename: 'Issue',
  id,
  number: 7,
  title,
  state: 'OPEN',
  url: `https://github.com/${repository}/issues/7`,
  repository: { nameWithOwner: repository },
});
function event(type: string, index = 1, source: unknown = prEndpoint, target: unknown = issue()) {
  const base = {
    __typename: type,
    id: `E${index}`,
    createdAt: new Date(Date.UTC(2026, 7, 29, 0, 0, index)).toISOString(),
  };
  if (type === 'ConnectedEvent' || type === 'DisconnectedEvent')
    return { ...base, source, subject: target };
  if (type === 'CrossReferencedEvent')
    return { ...base, source, target, referencedAt: base.createdAt, willCloseTarget: true };
  return { ...base, duplicate: source, canonical: target };
}
const page = (
  field: string,
  nodes: unknown[],
  totalCount = nodes.length,
  next: string | null = null,
  errors?: unknown[]
) => ({
  data: {
    data: {
      repository: {
        pullRequest: {
          id: 'PR',
          [field]: { nodes, totalCount, pageInfo: { hasNextPage: next !== null, endCursor: next } },
        },
      },
    },
    errors,
  },
});
let budget: ReturnType<typeof createContextReadBudget>;
beforeEach(() => {
  jest.useFakeTimers();
  budget = createContextReadBudget();
});
afterEach(() => {
  budget.close();
  jest.useRealTimers();
});
async function run(serve: (field: Field, after: string | null) => unknown) {
  const revision = {
    prNodeId: 'PR',
    number: 1,
    headSha: 'head',
    baseRef: 'main',
    baseSha: 'base',
    baseRepoFullName: 'o/r',
  };
  const octokit = {
    pulls: {
      get: async () => ({
        data: {
          node_id: 'PR',
          number: 1,
          title: 'PR',
          body: 'Fixes other/repo#99',
          user: null,
          state: 'open',
          head: { ref: 'feature', sha: 'head' },
          base: { ref: 'main', sha: 'base', repo: { full_name: 'o/r' } },
          commits: 1,
          changed_files: 1,
          additions: 1,
          deletions: 0,
          mergeable: null,
        },
      }),
    },
    request: async (
      _route: string,
      body: { query: string; variables: { after: string | null } }
    ) => {
      if (body.query === PR_CONTEXT_REVISION_QUERY)
        return {
          data: {
            data: {
              repository: {
                pullRequest: {
                  id: 'PR',
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
      const field = fields.find(field => PR_CONTEXT_ISSUE_QUERIES[field] === body.query);
      if (field) return serve(field, body.variables.after);
      const sibling = Object.entries({
        ...PR_CONTEXT_PEOPLE_QUERIES,
        ...PR_CONTEXT_REVIEW_QUERIES,
      }).find(([, query]) => query === body.query)?.[0];
      if (!sibling) throw new Error('Unexpected request');
      return page(sibling, []);
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

it('deduplicates by issue ID without losing categories, direction, full titles, or repository identity', async () => {
  const result = await run(field =>
    page(
      field,
      field === 'closingIssuesReferences'
        ? [issue()]
        : [
            event('ConnectedEvent'),
            event('CrossReferencedEvent', 2, issue(), prEndpoint),
            event('MarkedAsDuplicateEvent', 3),
            event('ConnectedEvent', 4, issue(), prEndpoint),
            event('ConnectedEvent', 5, prEndpoint, {
              ...issue('OTHER', 'other/repo'),
              state: 'CLOSED',
            }),
          ]
    )
  );
  expect(result.issues).toMatchObject({ completeness: 'complete', knownCount: 2, totalCount: 2 });
  expect(result.issues.items).toEqual([
    {
      id: 'I',
      number: 7,
      title,
      state: 'OPEN',
      url: 'https://github.com/o/r/issues/7',
      repository: 'o/r',
      relationships: [
        {
          category: 'closing',
          membership: 'current',
          evidenceId: 'I',
          sourceId: 'PR',
          targetId: 'I',
        },
        {
          category: 'connected',
          membership: 'current',
          evidenceId: 'E1',
          sourceId: 'PR',
          targetId: 'I',
        },
        {
          category: 'referenced',
          membership: 'historical',
          evidenceId: 'E2',
          sourceId: 'I',
          targetId: 'PR',
        },
        {
          category: 'duplicate',
          membership: 'current',
          evidenceId: 'E3',
          sourceId: 'PR',
          targetId: 'I',
        },
        {
          category: 'connected',
          membership: 'current',
          evidenceId: 'E4',
          sourceId: 'I',
          targetId: 'PR',
        },
      ],
    },
    {
      id: 'OTHER',
      number: 7,
      title,
      state: 'CLOSED',
      url: 'https://github.com/other/repo/issues/7',
      repository: 'other/repo',
      relationships: [
        {
          category: 'connected',
          membership: 'current',
          evidenceId: 'E5',
          sourceId: 'PR',
          targetId: 'OTHER',
        },
      ],
    },
  ]);
});

describe.each([
  ['ConnectedEvent', 'DisconnectedEvent'],
  ['MarkedAsDuplicateEvent', 'UnmarkedAsDuplicateEvent'],
])('%s removal', (added, removed) => {
  it.each([false, true])('replays complete history with reversed endpoints=%s', async reversed => {
    const source = reversed ? issue() : prEndpoint;
    const target = reversed ? prEndpoint : issue();
    const result = await run(field =>
      page(
        field,
        field === 'timelineItems'
          ? [event(added, 1, source, target), event(removed, 2, source, target)]
          : []
      )
    );
    expect(result.issues).toMatchObject({
      items: [],
      knownCount: 0,
      totalCount: 0,
      completeness: 'complete',
      source: { availability: 'available' },
    });
  });
  it('removes only the matching category and directed endpoint key', async () => {
    const result = await run(field =>
      page(
        field,
        field === 'closingIssuesReferences'
          ? [issue()]
          : [
              event(added),
              event(added, 2, issue(), prEndpoint),
              event(removed, 3),
              event('CrossReferencedEvent', 4),
            ]
      )
    );
    expect(result.issues.items[0]?.relationships).toMatchObject([
      { category: 'closing', membership: 'current' },
      { evidenceId: 'E2', sourceId: 'I', targetId: 'PR', membership: 'current' },
      { category: 'referenced', membership: 'historical' },
    ]);
  });
});

it.each([
  [issue(), issue('OTHER')],
  [{ ...prEndpoint, id: 'OTHER_PR' }, issue()],
  [prEndpoint, { ...prEndpoint, id: 'OTHER_PR' }],
])('ignores endpoints that do not join this PR to an issue: %p', async (source, target) => {
  const result = await run(field =>
    page(field, field === 'timelineItems' ? [event('ConnectedEvent', 1, source, target)] : [])
  );
  expect(result.issues).toMatchObject({ items: [], completeness: 'complete' });
});

it('paginates both sources past 100 entries with independent cursors', async () => {
  const result = await run((field, after) => {
    if (after !== null && after !== field) throw new Error('Wrong cursor');
    return page(
      field,
      Array.from({ length: after ? 1 : 100 }, (_, i) => {
        const index = i + (after ? 101 : 1);
        const endpoint = issue(`${field}-${index}`);
        return field === 'closingIssuesReferences'
          ? endpoint
          : event('ConnectedEvent', index, prEndpoint, endpoint);
      }),
      101,
      after ? null : field
    );
  });
  expect(result.issues).toMatchObject({
    completeness: 'complete',
    knownCount: 202,
    totalCount: 202,
    hasNextPage: false,
    source: { availability: 'available' },
  });
  expect(result.issues.items).toHaveLength(202);
  expect(result.issues.items.every(item => item.relationships[0]?.membership === 'current')).toBe(
    true
  );
});

it.each([403, 503])(
  'retains additions and removals as historical after a failed page: %s',
  async status => {
    const result = await run((field, after) => {
      if (field === 'closingIssuesReferences') return page(field, [issue()]);
      if (after) throw { status };
      return page(field, [event('ConnectedEvent'), event('DisconnectedEvent', 2)], 3, 'next');
    });
    expect(result.issues).toMatchObject({
      completeness: 'partial',
      totalCount: null,
      hasNextPage: true,
      source: { availability: 'partial', retryable: status === 503 },
    });
    expect(result.issues.items[0]?.relationships).toMatchObject([
      { category: 'closing', membership: 'current' },
      { evidenceId: 'E1', membership: 'historical' },
      { evidenceId: 'E2', membership: 'historical' },
    ]);
    expect(result.labels.completeness).toBe('complete');
  }
);

it.each([
  ['null source', event('DisconnectedEvent', 2, null), false],
  ['deleted issue', event('UnmarkedAsDuplicateEvent', 2, prEndpoint, null), false],
  ['null node', null, true],
  [
    'malformed issue',
    event('DisconnectedEvent', 2, prEndpoint, { ...issue(), number: null }),
    true,
  ],
  ['invalid time', { ...event('DisconnectedEvent', 2), createdAt: 'invalid' }, true],
  [
    'unordered events',
    { ...event('DisconnectedEvent', 2), createdAt: '2026-08-28T00:00:00Z' },
    true,
  ],
])('does not replay incomplete history: %s', async (_name, broken, retryable) => {
  const result = await run(field =>
    page(field, field === 'timelineItems' ? [event('ConnectedEvent'), broken] : [])
  );
  expect(result.issues).toMatchObject({
    completeness: 'partial',
    source: { availability: 'partial', retryable },
  });
  expect(result.issues.items[0]?.relationships[0]).toMatchObject({
    evidenceId: 'E1',
    membership: 'historical',
  });
});

it.each(['repeat', 'null-page', 'count-change'])(
  'keeps incomplete pagination historical: %s',
  async fault => {
    const result = await run((field, after) => {
      if (field === 'closingIssuesReferences') return page(field, []);
      if (!after) return page(field, [event('ConnectedEvent')], 2, 'next');
      if (fault === 'null-page')
        return { data: { data: { repository: { pullRequest: { timelineItems: null } } } } };
      return page(
        field,
        [event('DisconnectedEvent', 2)],
        fault === 'count-change' ? 3 : 2,
        fault === 'repeat' ? 'next' : null
      );
    });
    expect(result.issues).toMatchObject({ completeness: 'partial', source: { retryable: true } });
    expect(
      result.issues.items[0]?.relationships.every(link => link.membership === 'historical')
    ).toBe(true);
  }
);

it.each(fields)('preserves the successful sibling when %s is denied', async denied => {
  const result = await run(field => {
    if (field === denied)
      return page(field, [], 0, null, [
        { type: 'FORBIDDEN', path: ['repository', 'pullRequest', field] },
      ]);
    return page(field, field === 'timelineItems' ? [event('ConnectedEvent')] : [issue()]);
  });
  expect(result.issues).toMatchObject({
    knownCount: 1,
    completeness: 'partial',
    source: { availability: 'partial', retryable: false, reason: 'graphql-denied' },
  });
  expect(result.issues.items[0]?.relationships).toMatchObject([{ membership: 'current' }]);
});

it.each([
  ['FORBIDDEN', false, 'graphql-denied'],
  ['INTERNAL', true, 'graphql-incomplete'],
])(
  'preserves the retry policy for an event timestamp error: %s',
  async (type, retryable, reason) => {
    const result = await run(field => {
      if (field !== 'timelineItems') return page(field, []);
      return page(field, [{ ...event('ConnectedEvent'), createdAt: null }], 1, null, [
        { type, path: ['repository', 'pullRequest', field, 'nodes', 0, 'createdAt'] },
      ]);
    });
    expect(result.issues).toMatchObject({ completeness: 'partial', source: { retryable, reason } });
    expect(result.issues.items[0]?.relationships).toMatchObject([
      { evidenceId: 'E1', membership: 'historical' },
    ]);
  }
);

it.each([403, 503])('does not turn a failed source into supported emptiness: %s', async status => {
  const result = await run(() => {
    throw { status };
  });
  expect(result.issues).toMatchObject({
    items: [],
    completeness: 'unknown',
    totalCount: null,
    source: { availability: status === 403 ? 'denied' : 'unavailable', retryable: status === 503 },
  });
});

it('retains known event evidence when the shared deadline aborts a later page', async () => {
  const pending = run((field, after) =>
    field === 'closingIssuesReferences'
      ? page(field, [])
      : after
        ? new Promise(() => undefined)
        : page(field, [event('ConnectedEvent')], 2, 'next')
  );
  await jest.advanceTimersByTimeAsync(10_000);
  const result = await pending;
  expect(result.issues).toMatchObject({
    completeness: 'partial',
    source: { retryable: true, reason: 'deadline' },
  });
  expect(result.issues.items[0]?.relationships).toMatchObject([{ membership: 'historical' }]);
});

it('reports complete supported emptiness without parsing body references or claiming universal coverage', async () => {
  const result = await run(field => page(field, []));
  expect(result).toMatchObject({
    issueCoverage: 'supported-pr-sources',
    issues: {
      items: [],
      knownCount: 0,
      totalCount: 0,
      completeness: 'complete',
      hasNextPage: false,
      source: {
        availability: 'available',
        retryable: false,
        provenance: ['graphql.closingIssuesReferences', 'graphql.timelineItems'],
      },
    },
  });
});

it.each([null, 'https://github.com/o/r/issues/7'])(
  'retains issue identity and the available link across relationships: %s',
  async url => {
    const result = await run(field =>
      page(
        field,
        field === 'closingIssuesReferences'
          ? [{ ...issue(), url: null }]
          : [event('ConnectedEvent', 1, prEndpoint, { ...issue(), url })]
      )
    );
    expect(result.issues.items).toMatchObject([
      { id: 'I', title, repository: 'o/r', number: 7, url },
    ]);
  }
);

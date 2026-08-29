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

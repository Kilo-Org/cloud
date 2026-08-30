import { Octokit } from '@octokit/rest';
import {
  createContextReadBudget,
  readPullRequestContext,
  PR_CONTEXT_REVISION_QUERY,
} from './context-reader';
import { GitHubPrReviewContextSchema } from './context-dtos';
import { PR_CONTEXT_PEOPLE_QUERIES } from './context-people';
import { PR_CONTEXT_REVIEW_QUERIES } from './context-reviews';
import { PR_CONTEXT_ISSUE_QUERIES } from './context-issues';
import {
  PR_CONTEXT_EVALUATION_QUERY,
  PR_CONTEXT_REQUIREMENT_QUERIES,
} from './context-requirements';

const revision = {
  prNodeId: 'PR',
  number: 1,
  headSha: 'head',
  baseRepoFullName: 'upstream/policies',
  baseRef: 'release/1',
  baseSha: 'base',
};
const branchPath = '/repos/upstream/policies/branches/release/1';
const protectionPath = `${branchPath}/protection`;
const unprotected = { name: 'release/1', commit: { sha: 'base' }, protected: false };
const rulesPath = '/repos/upstream/policies/rules/branches/release/1';
const nextPage =
  'https://api.github.com/repos/upstream/policies/rules/branches/release%2F1?per_page=100&page=2';
const rule = {
  type: 'required_deployments',
  parameters: { required_deployment_environments: ['production'] },
  ruleset_id: 7,
  ruleset_source: 'upstream',
  ruleset_source_type: 'Organization' as const,
};
const protection = {
  required_status_checks: {
    strict: true,
    contexts: ['ci'],
    checks: [
      { context: 'ci', app_id: 7 },
      { context: 'ci', app_id: -1 },
      { context: 'ci', app_id: null },
    ],
  },
  required_pull_request_reviews: {
    required_approving_review_count: 2,
    require_code_owner_reviews: true,
    require_last_push_approval: true,
    dismiss_stale_reviews: true,
  },
  required_conversation_resolution: { enabled: true },
  required_signatures: { enabled: true },
};
const collections = {
  ...PR_CONTEXT_PEOPLE_QUERIES,
  ...PR_CONTEXT_REVIEW_QUERIES,
  ...PR_CONTEXT_ISSUE_QUERIES,
  ...PR_CONTEXT_REQUIREMENT_QUERIES,
};
const evaluationPr = {
  id: 'PR',
  number: 1,
  headRefOid: 'head',
  baseRefName: 'release/1',
  baseRefOid: 'base',
  baseRepository: { nameWithOwner: 'upstream/policies' },
  mergeable: 'MERGEABLE',
  viewerCanMergeAsAdmin: false,
  potentialMergeCommit: null,
  baseRef: {
    refUpdateRule: {
      requiredApprovingReviewCount: 2,
      requiredStatusCheckContexts: ['ci'],
      requiresConversationResolution: true,
    },
    compare: { behindBy: 0, baseTarget: { oid: 'base' }, headTarget: { oid: 'head' } },
  },
};
const empty = { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } };
const failure = (status: number) => Response.json({ message: 'provider-only' }, { status });
let budget: ReturnType<typeof createContextReadBudget>;
beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(console, 'info').mockImplementation(() => undefined);
  budget = createContextReadBudget();
});
afterEach(() => {
  budget.close();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

async function run(
  serve: (
    url: URL,
    options: RequestInit
  ) => Response | undefined | Promise<Response | undefined> = () => undefined,
  configure?: (octokit: Octokit) => void
) {
  const requests: string[] = [];
  let active = 0,
    peak = 0;
  const octokit = new Octokit({
    request: {
      fetch: async (input: string | URL | Request, options: RequestInit = {}) => {
        const url = new URL(String(input));
        requests.push(decodeURIComponent(url.pathname) + url.search);
        peak = Math.max(peak, ++active);
        try {
          const response = await serve(url, options);
          if (response) return response;
          const path = decodeURIComponent(url.pathname);
          if (path === '/repos/o/r/pulls/1')
            return Response.json({
              node_id: 'PR',
              number: 1,
              title: 'PR',
              body: null,
              user: null,
              state: 'open',
              head: { ref: 'feature', sha: 'head', repo: { full_name: 'fork/r' } },
              base: {
                ref: 'release/1',
                sha: 'base',
                repo: { full_name: 'upstream/policies', default_branch: 'main' },
              },
              commits: 1,
              changed_files: 1,
              additions: 1,
              deletions: 0,
              mergeable: null,
            });
          if (path === protectionPath) return Response.json(protection);
          if (path === branchPath) return Response.json(unprotected);
          if (path === rulesPath) return Response.json([rule]);
          const { query, variables } = JSON.parse(String(options.body));
          if (
            query === PR_CONTEXT_REQUIREMENT_QUERIES.checks ||
            query === PR_CONTEXT_REQUIREMENT_QUERIES.deployments
          )
            return Response.json({
              data: {
                repository: {
                  object: {
                    oid: variables.oid,
                    statusCheckRollup: { contexts: empty },
                    deployments: empty,
                  },
                },
              },
            });
          if (query === PR_CONTEXT_REVISION_QUERY || query === PR_CONTEXT_EVALUATION_QUERY)
            return Response.json({ data: { repository: { pullRequest: evaluationPr } } });
          const field = Object.entries(collections).find(([, document]) => document === query)?.[0];
          if (!field) throw new Error('Unexpected request');
          return Response.json({ data: { repository: { pullRequest: { [field]: empty } } } });
        } finally {
          active--;
        }
      },
    },
  });
  configure?.(octokit);
  const context = GitHubPrReviewContextSchema.parse(
    await readPullRequestContext(
      octokit,
      { owner: 'o', repo: 'r', number: 1, expectedRevision: revision },
      budget
    )
  );
  return { context, requests, peak };
}

it.each([
  {},
  { url: undefined },
  { url: null },
  { url: '' },
  { url: false },
  { url: 0 },
  { url: true },
  { url: 42 },
  { url: {} },
  { url: [] },
])('rejects invalid policy page parameters %p without adding ruleset evidence', async params => {
  const { context } = await run(undefined, octokit => {
    jest.spyOn(octokit.repos, 'getBranchRules').mockResolvedValue({
      status: 200,
      url: nextPage,
      headers: {},
      data: [{ ...rule, type: 'required_deployments' }],
    });
    jest.spyOn(octokit.paginate, 'iterator').mockImplementation(async function* (requestPage) {
      // @ts-expect-error These parameters are invalid on purpose to test runtime rejection.
      yield await requestPage(params);
    });
  });
  expect(context.requirements.items.filter(item => item.policy?.source === 'ruleset')).toEqual([]);
  expect(context.requirements.items.some(item => item.policy?.source === 'classic')).toBe(true);
  expect(context.requirements).toMatchObject({
    completeness: 'partial',
    source: { availability: 'partial', retryable: true },
  });
  expect(context.labels.completeness).toBe('complete');
});

it('retains exact-base policy evidence while adding named evaluation requirements', async () => {
  const { context, requests } = await run(url =>
    decodeURIComponent(url.pathname) === rulesPath
      ? Response.json([
          rule,
          { ...rule, type: 'future_rule', parameters: { nested: [true, null] } },
        ])
      : undefined
  );
  expect(context.requirements).toMatchObject({
    completeness: 'complete',
    knownCount: 12,
    source: { availability: 'available' },
  });
  const policies = context.requirements.items.filter(item => item.check === null);
  expect(policies.map(item => [item.kind, item.state])).toEqual([
    ['branch-freshness', 'met'],
    ['approving-reviews', 'unavailable'],
    ['code-owner-reviews', 'unavailable'],
    ['last-push-approval', 'unavailable'],
    ['stale-review-dismissal', 'unavailable'],
    ['conversation-resolution', 'met'],
    ['commit-signatures', 'unavailable'],
    ['deployment', 'unavailable'],
    ['future_rule', 'unavailable'],
  ]);
  expect(policies[0]?.policy?.parameters).toEqual(protection);
  expect(policies.find(item => item.kind === 'deployment')?.policy).toMatchObject({
    parameters: rule.parameters,
    ruleset: { id: 7, source: 'upstream', sourceType: 'Organization' },
    viewerBypass: 'unknown',
    viewerEnforcement: 'unknown',
  });
  for (const item of context.requirements.items) {
    expect(item.policy).toMatchObject({
      enforcement: 'active',
      bypassActors: null,
      base: { baseRepoFullName: 'upstream/policies', baseRef: 'release/1', baseSha: 'base' },
    });
    expect(item.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observation: 'policy-configuration',
          headSha: 'head',
          baseSha: 'base',
          evaluatedSha: null,
        }),
      ])
    );
  }
  expect(context.requirements.items.flatMap(item => (item.check ? [item.check] : []))).toEqual([
    { name: 'ci', kind: 'unknown', application: { kind: 'app', appId: 7 } },
    { name: 'ci', kind: 'unknown', application: { kind: 'any' } },
    { name: 'ci', kind: 'unknown', application: { kind: 'unknown' } },
  ]);
  expect(requests.filter(path => path.startsWith('/repos/upstream/'))).toEqual([
    protectionPath,
    `${rulesPath}?per_page=100`,
  ]);
  expect(context.labels.completeness).toBe('complete');
});

it.each(['done', '503', '403', '409', 'null', 'repeat'])(
  'preserves policy pages through %s',
  async outcome => {
    let pages = 0;
    const { context, requests } = await run(url => {
      if (decodeURIComponent(url.pathname) !== rulesPath) return;
      if (++pages > 2) return failure(503);
      if (!url.searchParams.has('page'))
        return Response.json(
          Array.from({ length: 100 }, (_, index) => ({ ...rule, ruleset_id: index + 1 })),
          { headers: { link: `<${nextPage}>; rel="next"` } }
        );
      if (outcome === 'null') return Response.json(null);
      if (!['done', 'repeat'].includes(outcome)) return failure(Number(outcome));
      return Response.json([{ ...rule, ruleset_id: 101 }], {
        headers: outcome === 'repeat' ? { link: `<${nextPage}>; rel="next"` } : {},
      });
    });
    expect(
      context.requirements.items.filter(item => item.policy?.source === 'ruleset')
    ).toHaveLength(['done', 'repeat'].includes(outcome) ? 101 : 100);
    expect(context.requirements).toMatchObject({
      completeness: outcome === 'done' ? 'complete' : 'partial',
      hasNextPage: outcome !== 'done',
      source: {
        availability: outcome === 'done' ? 'available' : 'partial',
        retryable: !['done', '403'].includes(outcome),
      },
    });
    expect(requests.filter(path => path.startsWith(rulesPath))).toHaveLength(2);
    expect(context.labels.completeness).toBe('complete');
  }
);

it.each([protectionPath, rulesPath])(
  'isolates denied and transient policy failures at %s',
  async path => {
    for (const status of [403, 404, 409, 503]) {
      const { context } = await run(url => {
        if (decodeURIComponent(url.pathname) === path) return failure(status);
        return undefined;
      });
      // The default exact-ref probe proves classic absence after 404; a rules 404 never does.
      const complete = path === protectionPath && status === 404;
      expect(context.requirements).toMatchObject({
        completeness: complete ? 'complete' : 'partial',
        source: { availability: complete ? 'available' : 'partial', retryable: status >= 409 },
      });
      expect(
        context.requirements.items.some(
          item => item.policy?.source === (path === rulesPath ? 'classic' : 'ruleset')
        )
      ).toBe(true);
      expect(context.labels.completeness).toBe('complete');
      expect(JSON.stringify(context)).not.toContain('provider-only');
    }
  }
);

it('confirms empty policies only after explicit exact-ref absence and empty active rules', async () => {
  const { context } = await run((url, options) => {
    if (decodeURIComponent(url.pathname) === protectionPath) return failure(404);
    if (decodeURIComponent(url.pathname) === rulesPath) return Response.json([]);
    if (
      url.pathname === '/graphql' &&
      JSON.parse(String(options.body)).query === PR_CONTEXT_EVALUATION_QUERY
    )
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              ...evaluationPr,
              baseRef: { ...evaluationPr.baseRef, refUpdateRule: null },
            },
          },
        },
      });
    return undefined;
  });
  expect(context.requirements).toMatchObject({
    items: [],
    completeness: 'complete',
    totalCount: 0,
    hasNextPage: false,
    source: { availability: 'available', retryable: false },
  });
});

it.each([
  [null, true],
  [{}, true],
  [{ ...unprotected, protected: undefined }, true],
  [{ ...unprotected, protected: null }, true],
  [{ ...unprotected, protected: true }, false],
  [{ ...unprotected, name: 'main' }, true],
  [{ ...unprotected, commit: { sha: 'other' } }, true],
  [403, false],
  [404, false],
  [503, true],
] as const)(
  'does not turn ambiguous classic absence %j into no policies',
  async (branch, retryable) => {
    const { context } = await run(url => {
      if (decodeURIComponent(url.pathname) === protectionPath) return failure(404);
      if (decodeURIComponent(url.pathname) === rulesPath) return Response.json([]);
      if (decodeURIComponent(url.pathname) === branchPath)
        return typeof branch === 'number' ? failure(branch) : Response.json(branch);
      return undefined;
    });
    expect(context.requirements).toMatchObject({
      items: [],
      completeness: 'unknown',
      totalCount: null,
      source: { retryable },
    });
    expect(context.requirements.source.availability).not.toBe('available');
    expect(context.labels.completeness).toBe('complete');
  }
);

it.each([200, 503, 401])('shares one policy authentication probe with status %s', async status => {
  let pulls = 0;
  const pending = run(url => {
    const path = decodeURIComponent(url.pathname);
    if (path === protectionPath || path === rulesPath) return failure(401);
    if (path === '/repos/o/r/pulls/1' && ++pulls > 1 && status !== 200) return failure(status);
    return undefined;
  });
  if (status === 401) await expect(pending).rejects.toMatchObject({ status: 401 });
  else {
    const { context, peak } = await pending;
    expect(context.requirements).toMatchObject({
      items: [],
      completeness: 'unknown',
      source: {
        availability: status === 200 ? 'denied' : 'unavailable',
        retryable: status !== 200,
        reason: status === 200 ? 'optional-permission-denied' : 'credential-probe-inconclusive',
      },
    });
    expect(context.labels.completeness).toBe('complete');
    expect(peak).toBeLessThanOrEqual(4);
  }
  expect(pulls).toBe(2);
});

it('shares four request slots and aborts late policy pages at the ten-second deadline', async () => {
  const started = Promise.withResolvers<void>();
  let aborted = false;
  const pending = run((url, options) => {
    if (decodeURIComponent(url.pathname) !== rulesPath) return;
    if (!url.searchParams.has('page'))
      return Response.json([rule], { headers: { link: `<${nextPage}>; rel="next"` } });
    started.resolve();
    return new Promise(resolve =>
      options.signal?.addEventListener(
        'abort',
        () => {
          aborted = true;
          resolve(Response.json([{ ...rule, ruleset_id: 99 }]));
        },
        { once: true }
      )
    );
  });
  await started.promise;
  await jest.advanceTimersByTimeAsync(10_000);
  const { context, peak, requests } = await pending;
  expect(
    context.requirements.items
      .filter(item => item.policy?.source === 'ruleset')
      .map(item => item.policy?.ruleset?.id)
  ).toEqual([7]);
  expect(context.requirements.source).toMatchObject({
    availability: 'unavailable',
    reason: 'deadline',
    retryable: true,
  });
  expect(context.labels.completeness).toBe('complete');
  expect(aborted).toBe(true);
  expect(peak).toBe(4);
  expect(requests.filter(path => path.startsWith(rulesPath))).toHaveLength(2);
});

const observedRun = {
  __typename: 'CheckRun',
  id: 'RUN',
  name: 'ci',
  status: 'COMPLETED',
  conclusion: 'FAILURE',
  isRequired: true,
  detailsUrl: null,
  checkSuite: {
    commit: { oid: 'head' },
    app: { databaseId: 7, id: 'APP_7', slug: 'ci-app', name: 'CI' },
  },
};
function checkPage(
  nodes: unknown[],
  pageInfo: { hasNextPage: boolean; endCursor: string | null } = empty.pageInfo,
  totalCount = nodes.length,
  errors: unknown[] = []
) {
  return Response.json({
    data: {
      repository: {
        object: { oid: 'head', statusCheckRollup: { contexts: { nodes, totalCount, pageInfo } } },
      },
    },
    errors,
  });
}

it('paginates PR-scoped checks while retaining application, kind, and optional failures', async () => {
  const { context, peak } = await run((url, options) => {
    if (url.pathname !== '/graphql') return;
    const { query, variables } = JSON.parse(String(options.body));
    if (query !== PR_CONTEXT_REQUIREMENT_QUERIES.checks) return;
    if (variables.pr !== 'PR' || variables.oid !== 'head') throw new Error('Wrong check identity');
    if (!variables.after)
      return checkPage([observedRun], { hasNextPage: true, endCursor: 'next' }, 3);
    if (variables.after !== 'next') throw new Error('Wrong check cursor');
    return checkPage(
      [
        { ...observedRun, id: 'OPTIONAL', name: 'optional', isRequired: false },
        {
          __typename: 'StatusContext',
          id: 'STATUS',
          context: 'ci',
          state: 'SUCCESS',
          isRequired: true,
          targetUrl: null,
          commit: { oid: 'head' },
        },
      ],
      empty.pageInfo,
      3
    );
  });
  expect(context.checks).toMatchObject({
    completeness: 'complete',
    items: [
      {
        id: 'RUN',
        kind: 'check-run',
        application: { id: 7, nodeId: 'APP_7' },
        requiredness: 'required',
        outcome: 'failure',
        evaluatedSha: 'head',
      },
      { id: 'OPTIONAL', requiredness: 'optional', outcome: 'failure' },
      {
        id: 'STATUS',
        kind: 'status',
        application: null,
        requiredness: 'required',
        outcome: 'success',
      },
    ],
  });
  expect(context.requirements.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        state: 'unmet',
        check: { name: 'ci', kind: 'check-run', application: { kind: 'app', appId: 7 } },
      }),
      expect.objectContaining({
        state: 'met',
        check: { name: 'ci', kind: 'status', application: { kind: 'any' } },
      }),
    ])
  );
  for (const row of context.requirements.items.filter(item => item.state === 'unmet')) {
    expect(row.policy?.base).toEqual({
      baseRepoFullName: 'upstream/policies',
      baseRef: 'release/1',
      baseSha: 'base',
    });
    expect(row.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          policyId: row.policy?.id,
          headSha: 'head',
          baseSha: 'base',
          evaluatedSha: 'head',
          observation: 'isRequired:required',
        }),
        expect.objectContaining({
          policyId: row.policy?.id,
          observation: 'check:RUN:failure;status:COMPLETED;conclusion:FAILURE',
        }),
      ])
    );
    expect(row.evidence.some(entry => entry.observation.includes('OPTIONAL'))).toBe(false);
  }
  expect(peak).toBeLessThanOrEqual(4);
  expect(context.labels.completeness).toBe('complete');
});

it.each([true, false])('does not trust an errored isRequired value of %s', async isRequired => {
  const { context } = await run((url, options) => {
    if (
      url.pathname !== '/graphql' ||
      JSON.parse(String(options.body)).query !== PR_CONTEXT_REQUIREMENT_QUERIES.checks
    )
      return;
    return checkPage([{ ...observedRun, isRequired }], empty.pageInfo, 1, [
      {
        type: 'FORBIDDEN',
        path: ['repository', 'object', 'statusCheckRollup', 'contexts', 'nodes', 0, 'isRequired'],
      },
    ]);
  });
  expect(context.checks).toMatchObject({
    source: { availability: 'partial', retryable: false },
    items: [{ requiredness: 'unknown', outcome: 'failure' }],
  });
  expect(
    context.requirements.items
      .filter(item => item.check)
      .every(item => item.state === 'unavailable')
  ).toBe(true);
  expect(context.labels.completeness).toBe('complete');
});

it.each(['head', 'base'])(
  'invalidates observed failures when the final %s revision changes',
  async changed => {
    const { context } = await run((url, options) => {
      if (url.pathname !== '/graphql') return;
      const { query } = JSON.parse(String(options.body));
      if (query === PR_CONTEXT_REQUIREMENT_QUERIES.checks) return checkPage([observedRun]);
      if (query === PR_CONTEXT_REVISION_QUERY)
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                id: 'PR',
                number: 1,
                headRefOid: changed === 'head' ? 'new-head' : 'head',
                baseRefName: 'release/1',
                baseRefOid: changed === 'base' ? 'new-base' : 'base',
                baseRepository: { nameWithOwner: 'upstream/policies' },
              },
            },
          },
        });
      return undefined;
    });
    expect(context.checks).toMatchObject({
      source: { availability: 'stale', retryable: true },
      items: [{ id: 'RUN', outcome: 'failure', requiredness: 'unknown', observation: 'unknown' }],
    });
    expect(context.requirements.items.every(item => item.state === 'unavailable')).toBe(true);
    expect(context.labels.completeness).toBe('complete');
  }
);

it('returns available evaluation sources instead of compatibility defaults', async () => {
  const { context } = await run();
  for (const source of Object.values(context.evaluationSources)) {
    expect(source).toMatchObject({
      availability: 'available',
      retryable: false,
      reason: null,
      provenance: expect.arrayContaining([expect.stringMatching(/^graphql\./)]),
    });
  }
});

describe.each([403, 503])('evaluation source recovery for HTTP %s', status => {
  it.each([
    ['current', 'available', false, null],
    ['head', 'stale', true, 'revision-mismatch'],
    ['base', 'stale', true, 'revision-mismatch'],
    ['denied', 'denied', false, 'forbidden'],
    ['unavailable', 'unavailable', true, 'bad_gateway'],
  ] as const)(
    'preserves failed sources while fencing successful sources for final revision %s',
    async (finalRevision, availability, retryable, reason) => {
      const { context } = await run((url, options) => {
        if (url.pathname !== '/graphql') return;
        const { query } = JSON.parse(String(options.body));
        if (query === PR_CONTEXT_REQUIREMENT_QUERIES.checks) return checkPage([observedRun]);
        if (
          [
            PR_CONTEXT_REQUIREMENT_QUERIES.reviewThreads,
            PR_CONTEXT_REQUIREMENT_QUERIES.eligibleReviews,
            PR_CONTEXT_REQUIREMENT_QUERIES.deployments,
          ].includes(query)
        )
          return failure(status);
        if (query === PR_CONTEXT_EVALUATION_QUERY)
          return Response.json({
            data: { repository: { pullRequest: evaluationPr } },
            errors: [
              {
                type: status === 403 ? 'FORBIDDEN' : 'INTERNAL',
                path: ['repository', 'pullRequest', 'baseRef', 'compare'],
              },
            ],
          });
        if (query === PR_CONTEXT_REVISION_QUERY) {
          if (finalRevision === 'denied') return failure(403);
          if (finalRevision === 'unavailable') return failure(503);
          return Response.json({
            data: {
              repository: {
                pullRequest: {
                  ...evaluationPr,
                  headRefOid: finalRevision === 'head' ? 'new-head' : 'head',
                  baseRefOid: finalRevision === 'base' ? 'new-base' : 'base',
                },
              },
            },
          });
        }
        return undefined;
      });
      expect(context.evaluationSources.comparison).toMatchObject({
        availability: 'partial',
        retryable: status === 503,
        reason: status === 403 ? 'graphql-denied' : 'graphql-incomplete',
        provenance: ['graphql.requirements'],
      });
      for (const [key, field] of [
        ['threads', 'reviewThreads'],
        ['eligibleReviews', 'eligibleReviews'],
        ['deployments', 'deployments'],
      ] as const) {
        expect(context.evaluationSources[key]).toMatchObject({
          availability: status === 403 ? 'denied' : 'unavailable',
          retryable: status === 503,
          reason: status === 403 ? 'forbidden' : 'bad_gateway',
          provenance: [`graphql.${field}`],
        });
      }
      for (const [key, source] of Object.entries(context.evaluationSources)) {
        if (['comparison', 'threads', 'eligibleReviews', 'deployments'].includes(key)) continue;
        expect(source).toMatchObject({
          availability,
          retryable,
          reason,
          provenance: expect.arrayContaining([expect.stringMatching(/^graphql\./)]),
        });
      }
      expect(context.requirements.items.some(item => item.state === 'unmet')).toBe(
        finalRevision === 'current'
      );
      expect(context.checks).toMatchObject({
        source: { availability, retryable, reason },
        items: [{ id: 'RUN', outcome: 'failure' }],
      });
      expect(context.reviewActivity).toMatchObject({
        completeness: 'complete',
        source: { availability: 'available', retryable: false, reason: null },
      });
      expect(context.labels.completeness).toBe('complete');
    }
  );
});

describe('evaluation identity', () => {
  const fields = ['id', 'number', 'headRefOid', 'baseRefName', 'baseRefOid', 'baseRepository'];
  const review = {
    id: 'IDENTITY_REVIEW',
    state: 'APPROVED',
    submittedAt: '2026-08-29T00:00:00Z',
    commit: { oid: 'head' },
    author: null,
    onBehalfOf: empty,
  };

  function readIdentity(patch: Record<string, unknown>, errors: unknown[] = []) {
    return run((url, options) => {
      if (url.pathname !== '/graphql') return;
      const { query } = JSON.parse(String(options.body));
      if (query === PR_CONTEXT_EVALUATION_QUERY)
        return Response.json({
          data: {
            repository: {
              pullRequest: { ...evaluationPr, mergeable: 'CONFLICTING', ...patch },
            },
          },
          errors,
        });
      if (query === PR_CONTEXT_REQUIREMENT_QUERIES.checks) return checkPage([observedRun]);
      const field = Object.entries(PR_CONTEXT_REVIEW_QUERIES).find(
        ([, document]) => query === document
      )?.[0];
      if (field)
        return Response.json({
          data: {
            repository: {
              pullRequest: { [field]: { ...empty, nodes: [review], totalCount: 1 } },
            },
          },
        });
      return undefined;
    });
  }

  it.each([
    ...fields.flatMap(field => [null, undefined, '', {}].map(value => [field, value] as const)),
    ...[null, undefined, '', {}].map(
      value => ['baseRepository', { nameWithOwner: value }] as const
    ),
  ])('rejects evaluation %s=%p without borrowing outer identity', async (field, value) => {
    const { context } = await readIdentity({ [field]: value });
    expect(context.revision).toEqual(revision);
    expect(context.requirements.items.find(item => item.kind === 'merge-conflicts')).toMatchObject({
      state: 'unavailable',
      evidence: [expect.objectContaining({ observation: 'mergeable:unavailable' })],
    });
    expect(context.requirements).toMatchObject({
      completeness: 'complete',
      source: { availability: 'available', retryable: false, reason: null },
    });
    for (const key of [
      'mergeable',
      'testMerge',
      'comparison',
      'canBypassClassic',
      'requiredApprovingReviewCount',
      'requiredStatusCheckContexts',
      'requiresConversationResolution',
    ] as const) {
      expect(context.evaluationSources[key].availability).toBe('unavailable');
    }
    expect(context.checks).toMatchObject({
      completeness: 'partial',
      knownCount: 1,
      source: { availability: 'partial' },
      items: [{ id: 'RUN', outcome: 'failure', requiredness: 'required', observation: 'observed' }],
    });
    for (const collection of [context.reviewDecisions, context.reviewActivity]) {
      expect(collection).toMatchObject({
        items: [{ id: 'IDENTITY_REVIEW', state: 'APPROVED', submittedAt: review.submittedAt }],
        completeness: 'complete',
        source: { availability: 'available', retryable: false, reason: null },
      });
    }
    for (const key of [
      'threads',
      'eligibleReviews',
      'deployments',
      'reviewDecisions',
      'reviewActivity',
    ] as const) {
      expect(context.evaluationSources[key]).toMatchObject({
        availability: 'available',
        retryable: false,
        reason: null,
      });
    }
    expect(context.labels.completeness).toBe('complete');
  });

  it.each(
    [...fields, 'baseRepository.nameWithOwner'].flatMap(field =>
      ['FORBIDDEN', 'INTERNAL'].map(type => [field, type] as const)
    )
  )('retains %s identity failure metadata for %s', async (field, type) => {
    const { context } = await readIdentity({}, [
      { type, path: ['repository', 'pullRequest', ...field.split('.')] },
    ]);
    expect(context.requirements.items.find(item => item.kind === 'merge-conflicts')).toMatchObject({
      state: 'unavailable',
      evidence: [expect.objectContaining({ observation: 'mergeable:unavailable' })],
    });
    for (const key of ['mergeable', 'testMerge', 'comparison', 'canBypassClassic'] as const) {
      expect(context.evaluationSources[key]).toMatchObject({
        availability: 'unavailable',
        retryable: type === 'INTERNAL',
        reason: type === 'FORBIDDEN' ? 'graphql-denied' : 'graphql-incomplete',
        provenance: ['graphql.requirements'],
      });
    }
    expect(context.reviewDecisions).toMatchObject({
      items: [{ id: 'IDENTITY_REVIEW', state: 'APPROVED' }],
      source: { availability: 'available' },
    });
    expect(context.checks.items).toMatchObject([{ id: 'RUN', outcome: 'failure' }]);
    expect(context.requirements.source.availability).toBe('available');
  });

  it.each([
    ['CONFLICTING', 'unmet'],
    ['UNKNOWN', 'unavailable'],
    ['MERGEABLE', null],
  ] as const)('accepts complete matching identity for %s', async (mergeable, state) => {
    const { context } = await readIdentity({ mergeable });
    const conflicts = context.requirements.items.filter(item => item.kind === 'merge-conflicts');
    if (state === null) expect(conflicts).toEqual([]);
    else
      expect(conflicts).toMatchObject([
        {
          state,
          evidence: [
            expect.objectContaining({
              source: 'graphql.requirements',
              policyId: 'github:merge-conflicts',
              headSha: 'head',
              baseSha: 'base',
              evaluatedSha: 'head',
              observedAt: expect.any(String),
            }),
          ],
        },
      ]);
    expect(context.evaluationSources.mergeable).toMatchObject({
      availability: 'available',
      retryable: false,
      reason: null,
    });
    expect(context.checks).toMatchObject({
      completeness: 'complete',
      items: [{ id: 'RUN', outcome: 'failure', requiredness: 'required' }],
    });
  });

  it.each([
    { headRefOid: 'other-head', baseRepository: null },
    { headRefOid: 'other-head', baseRefOid: null },
    { headRefOid: 'other-head', baseRefName: '' },
    { baseRefOid: 'other-base', baseRepository: null },
  ])('preserves known mismatches in incomplete evaluation identity: %p', async patch => {
    const { context } = await readIdentity(patch);
    expect(context.requirements.source).toMatchObject({
      availability: 'stale',
      retryable: true,
      reason: 'revision-mismatch',
    });
    expect(context.requirements.items.every(item => item.state === 'unavailable')).toBe(true);
    expect(context.checks.items).toMatchObject([
      { id: 'RUN', requiredness: 'unknown', observation: 'unknown' },
    ]);
    expect(context.reviewDecisions.source.availability).toBe('stale');
    expect(context.reviewActivity.source.availability).toBe('available');
    expect(context.evaluationSources.mergeable.availability).toBe('unavailable');
    expect(context.labels.completeness).toBe('complete');
  });

  it('does not fence context with an errored mismatching evaluation identity', async () => {
    const { context } = await readIdentity({ headRefOid: 'other-head', baseRepository: null }, [
      { type: 'FORBIDDEN', path: ['repository', 'pullRequest', 'headRefOid'] },
    ]);
    expect(context.requirements.source.availability).toBe('available');
    expect(context.checks.items).toMatchObject([
      { id: 'RUN', requiredness: 'required', observation: 'observed' },
    ]);
    expect(context.reviewDecisions.source.availability).toBe('available');
    expect(context.evaluationSources.mergeable.availability).toBe('unavailable');
  });

  it.each([
    [
      'denied base repository',
      { headRefOid: 'other-head', baseRepository: null },
      ['baseRepository'],
    ],
    [
      'errored base repository name',
      { headRefOid: 'other-head', baseRepository: { nameWithOwner: 'other/policies' } },
      ['baseRepository', 'nameWithOwner'],
    ],
    ['omitted base repository', { headRefOid: 'other-head', baseRepository: undefined }, null],
    [
      'invalid base repository',
      { headRefOid: 'other-head', baseRepository: { nameWithOwner: 42 } },
      null,
    ],
    ['omitted base oid', { headRefOid: 'other-head', baseRefOid: undefined }, null],
    ['invalid base ref', { headRefOid: 'other-head', baseRefName: {} }, null],
    ['errored head', { headRefOid: 'other-head', baseRefOid: 'other-base' }, ['headRefOid']],
    ['omitted head', { headRefOid: undefined, baseRefOid: 'other-base' }, null],
    ['invalid head', { headRefOid: {}, baseRefOid: 'other-base' }, null],
    [
      'omitted base oid beside a changed repository',
      { baseRefOid: undefined, baseRepository: { nameWithOwner: 'other/policies' } },
      null,
    ],
  ] as const)(
    'fences reliable evaluation mismatches beside %s',
    async (_label, patch, errorPath) => {
      const { context } = await readIdentity(
        patch,
        errorPath ? [{ type: 'FORBIDDEN', path: ['repository', 'pullRequest', ...errorPath] }] : []
      );
      expect(context.revision).toEqual(revision);
      for (const collection of [context.requirements, context.checks, context.reviewDecisions]) {
        expect(collection).toMatchObject({
          completeness: 'unknown',
          source: { availability: 'stale', retryable: true, reason: 'revision-mismatch' },
        });
      }
      expect(context.requirements.items.every(item => item.state === 'unavailable')).toBe(true);
      expect(context.checks.items).toMatchObject([
        { id: 'RUN', outcome: 'failure', requiredness: 'unknown', observation: 'unknown' },
      ]);
      expect(context.evaluationSources.mergeable.availability).toBe('unavailable');
      expect(context.evaluationSources.threads).toMatchObject({
        availability: 'stale',
        retryable: true,
        reason: 'revision-mismatch',
      });
      expect(context.reviewActivity).toMatchObject({
        items: [{ id: 'IDENTITY_REVIEW', state: 'APPROVED' }],
        completeness: 'complete',
        source: { availability: 'available' },
      });
      expect(context.labels.completeness).toBe('complete');
    }
  );

  it.each([
    ['baseRefOid', { headRefOid: undefined, baseRefOid: 'other-base' }],
    [
      'baseRepository.nameWithOwner',
      { baseRefOid: undefined, baseRepository: { nameWithOwner: 'other/policies' } },
    ],
  ] as const)(
    'ignores an errored %s mismatch beside unavailable identity',
    async (field, patch) => {
      const { context } = await readIdentity(patch, [
        { type: 'FORBIDDEN', path: ['repository', 'pullRequest', ...field.split('.')] },
      ]);
      expect(context.requirements.source.availability).toBe('available');
      expect(context.checks.items).toMatchObject([
        { id: 'RUN', requiredness: 'required', observation: 'observed' },
      ]);
      expect(context.reviewDecisions).toMatchObject({
        items: [{ id: 'IDENTITY_REVIEW', state: 'APPROVED' }],
        source: { availability: 'available' },
      });
      expect(context.evaluationSources.mergeable).toMatchObject({
        availability: 'denied',
        retryable: false,
        reason: 'graphql-denied',
      });
    }
  );

  it.each([
    { id: 'OTHER_PR' },
    { number: 2 },
    { headRefOid: 'other-head' },
    { baseRefName: 'main' },
    { baseRefOid: 'other-base' },
    { baseRepository: { nameWithOwner: 'other/policies' } },
  ])('fences a complete mismatching evaluation identity: %p', async patch => {
    const { context } = await readIdentity(patch);
    expect(context.requirements.items.find(item => item.kind === 'merge-conflicts')).toMatchObject({
      state: 'unavailable',
    });
    expect(context.requirements.source).toMatchObject({
      availability: 'stale',
      retryable: true,
      reason: 'revision-mismatch',
    });
    expect(context.evaluationSources.mergeable.availability).toBe('stale');
    expect(context.checks.items).toMatchObject([
      { id: 'RUN', outcome: 'failure', requiredness: 'unknown', observation: 'unknown' },
    ]);
    expect(context.reviewActivity).toMatchObject({
      items: [{ id: 'IDENTITY_REVIEW', state: 'APPROVED' }],
      source: { availability: 'available' },
    });
  });
});

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
          const { query } = JSON.parse(String(options.body));
          if (query === PR_CONTEXT_REVISION_QUERY)
            return Response.json({
              data: {
                repository: {
                  pullRequest: {
                    id: 'PR',
                    number: 1,
                    headRefOid: 'head',
                    baseRefName: 'release/1',
                    baseRefOid: 'base',
                    baseRepository: { nameWithOwner: 'upstream/policies' },
                  },
                },
              },
            });
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

it('reads exact-base classic and inherited active policies without evaluating them', async () => {
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
    knownCount: 6,
    source: { availability: 'available' },
  });
  const policies = context.requirements.items.filter(item => item.check === null);
  expect(policies.map(item => item.kind)).toEqual([
    'branch_protection',
    'required_deployments',
    'future_rule',
  ]);
  expect(policies[0]?.policy?.parameters).toEqual(protection);
  expect(policies[1]?.policy).toMatchObject({
    parameters: rule.parameters,
    ruleset: { id: 7, source: 'upstream', sourceType: 'Organization' },
  });
  for (const item of context.requirements.items) {
    expect(item).toMatchObject({
      state: 'unavailable',
      policy: {
        enforcement: 'active',
        viewerBypass: 'unknown',
        viewerEnforcement: 'unknown',
        bypassActors: null,
        base: { baseRepoFullName: 'upstream/policies', baseRef: 'release/1', baseSha: 'base' },
      },
      evidence: [expect.objectContaining({ headSha: 'head', baseSha: 'base', evaluatedSha: null })],
    });
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
  const { context } = await run(url => {
    if (decodeURIComponent(url.pathname) === protectionPath) return failure(404);
    if (decodeURIComponent(url.pathname) === rulesPath) return Response.json([]);
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

import {
  GitHubPrReviewContextSchema,
  type GitHubPrReviewContext,
  type GitHubPrReviewRevision,
  type GitHubPrReviewSource,
} from './context-dtos';
import { normalizeContextPolicies } from './context-rules';
import {
  contextCheckSchema,
  evaluateContextRequirements,
  type RequirementCollection,
  type RequirementFacts,
  type RequirementObservations,
} from './context-requirements';

type Check = GitHubPrReviewContext['checks']['items'][number];
const revision: GitHubPrReviewRevision = {
  prNodeId: 'PR',
  number: 1,
  headSha: 'head',
  baseRepoFullName: 'o/r',
  baseRef: 'release',
  baseSha: 'base',
};
const source: GitHubPrReviewSource = {
  availability: 'available',
  retryable: false,
  reason: null,
  provenance: ['graphql.observation'],
  observedAt: '2026-08-29T00:00:00Z',
};
const collection = <T>(
  items: T[],
  patch: Partial<RequirementCollection<T>> = {}
): RequirementCollection<T> => ({
  items,
  source,
  completeness: 'complete',
  knownCount: items.length,
  totalCount: items.length,
  hasNextPage: false,
  endCursor: null,
  ...patch,
});
const field = <T>(data: T) => ({ data, source });
const checkPolicy = (app_id: number | null = -1, strict = false) => ({
  required_status_checks: { strict, contexts: ['ci'], checks: [{ context: 'ci', app_id }] },
});
const reviewPolicy = {
  required_pull_request_reviews: {
    required_approving_review_count: 2,
    dismiss_stale_reviews: false,
    require_code_owner_reviews: false,
    require_last_push_approval: false,
  },
};
function setup(classic: unknown = checkPolicy(), rules: unknown[] = []) {
  const context = GitHubPrReviewContextSchema.parse({ revision });
  context.requirements = normalizeContextPolicies(
    revision,
    collection(classic === null ? [] : [classic], {
      source: { ...source, provenance: ['rest.branchProtection'] },
    }),
    collection(rules, { source: { ...source, provenance: ['rest.branchRules'] } })
  );
  context.reviewDecisions = collection([]);
  context.reviewActivity = collection([]);
  const configured = classic as Partial<
    ReturnType<typeof checkPolicy> &
      typeof reviewPolicy & {
        required_conversation_resolution: { enabled: boolean };
      }
  > | null;
  const facts: RequirementFacts = {
    mergeable: field('MERGEABLE'),
    testMerge: field(null),
    canBypassClassic: field(false),
    comparison: field({ behindBy: 0, baseTarget: { oid: 'base' }, headTarget: { oid: 'head' } }),
    viewerRule: {
      requiredApprovingReviewCount: field(
        configured?.required_pull_request_reviews?.required_approving_review_count ?? 0
      ),
      requiredStatusCheckContexts: field(configured?.required_status_checks?.contexts ?? []),
      requiresConversationResolution: field(
        configured?.required_conversation_resolution?.enabled ?? false
      ),
    },
  };
  const observations: RequirementObservations = {
    head: collection([]),
    merge: null,
    threads: collection([]),
    eligibleReviews: collection([]),
    deployments: collection([]),
  };
  return { context, facts, observations };
}
type Scenario = ReturnType<typeof setup>;
const evaluate = ({ context, facts, observations }: Scenario) =>
  evaluateContextRequirements(context, facts, observations);
const requirements = (scenario: Scenario, kind: string) =>
  evaluate(scenario).requirements.items.filter(row => row.kind === kind);
function run(id: string, app = 7, patch: Record<string, unknown> = {}) {
  return {
    __typename: 'CheckRun',
    id,
    name: 'ci',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    isRequired: true,
    detailsUrl: null,
    checkSuite: {
      app: { id: `APP_${app}`, databaseId: app, slug: `app-${app}`, name: 'Same display name' },
      commit: { oid: 'head' },
    },
    ...patch,
  };
}
function status(id: string, patch: Record<string, unknown> = {}) {
  return {
    __typename: 'StatusContext',
    id,
    context: 'ci',
    state: 'SUCCESS',
    targetUrl: null,
    isRequired: true,
    commit: { oid: 'head' },
    ...patch,
  };
}
function check(raw: unknown): Check {
  const result = contextCheckSchema.parse(raw);
  result.evidence = [
    {
      source: 'graphql.checks.isRequired',
      policyId: null,
      observation: `isRequired:${result.requiredness}`,
      headSha: 'head',
      baseSha: 'base',
      evaluatedSha: result.evaluatedSha,
      observedAt: source.observedAt,
    },
    {
      source: 'graphql.checks',
      policyId: null,
      observation: `check:${result.id}:${result.outcome}`,
      headSha: 'head',
      baseSha: 'base',
      evaluatedSha: result.evaluatedSha,
      observedAt: source.observedAt,
    },
  ];
  return result;
}

it('preserves both required run and status outcomes under an explicit wildcard', () => {
  const scenario = setup();
  scenario.observations.head = collection([
    check(run('RUN')),
    check(status('STATUS', { state: 'FAILURE' })),
  ]);
  expect(requirements(scenario, 'status-check')).toMatchObject([
    { state: 'met', check: { kind: 'check-run', application: { kind: 'any' } } },
    { state: 'unmet', check: { kind: 'status', application: { kind: 'any' } } },
  ]);
});

it.each(['failure', 'missing'] as const)(
  'retains current proof for a required check %s',
  outcome => {
    const scenario = setup(checkPolicy(7));
    if (outcome === 'failure')
      scenario.observations.head = collection([check(run('FAILED', 7, { conclusion: 'FAILURE' }))]);
    const [row] = requirements(scenario, 'status-check');
    expect(row).toMatchObject({
      state: 'unmet',
      check: { name: 'ci', application: { kind: 'app', appId: 7 } },
      policy: {
        enforcement: 'active',
        base: { baseRepoFullName: 'o/r', baseRef: 'release', baseSha: 'base' },
        viewerEnforcement: 'enforced',
        viewerBypass: 'never',
      },
    });
    for (const entry of row.evidence)
      expect(entry).toMatchObject({
        policyId: row.policy?.id,
        headSha: 'head',
        baseSha: 'base',
        observedAt: source.observedAt,
      });
    expect(
      row.evidence.map(entry => [entry.source, entry.observation, entry.evaluatedSha])
    ).toEqual([
      ['rest.branchProtection', 'policy-configuration', null],
      ...(outcome === 'failure'
        ? [
            ['graphql.checks.isRequired', 'isRequired:required', 'head'],
            ['graphql.checks', 'check:FAILED:failure', 'head'],
          ]
        : [
            [
              'graphql.observation',
              'required-check-missing:complete-policy-and-observations',
              'head',
            ],
          ]),
    ]);
  }
);

it.each(['graphql.checks', 'graphql.checks.isRequired'])(
  'does not report a required failure without %s evidence',
  missingSource => {
    const scenario = setup();
    const observed = check(run('FAILED', 7, { conclusion: 'FAILURE' }));
    observed.evidence = observed.evidence.filter(entry => entry.source !== missingSource);
    scenario.observations.head = collection([observed]);
    expect(requirements(scenario, 'status-check')).toMatchObject([{ state: 'unavailable' }]);
  }
);

it('does not use stale evidence for a check that names the current commit', () => {
  const scenario = setup();
  const observed = check(run('FAILED', 7, { conclusion: 'FAILURE' }));
  observed.evidence = observed.evidence.map(entry => ({ ...entry, headSha: 'old-head' }));
  scenario.observations.head = collection([observed]);
  expect(requirements(scenario, 'status-check')).toMatchObject([{ state: 'unavailable' }]);
});

it('retains an optional failure without making it a requirement blocker', () => {
  const scenario = setup();
  scenario.observations.head = collection([
    check(run('REQUIRED')),
    check(run('OPTIONAL', 7, { name: 'lint', conclusion: 'FAILURE', isRequired: false })),
  ]);
  const result = evaluate(scenario);
  expect(result.checks.items).toMatchObject([
    { id: 'REQUIRED', requiredness: 'required', outcome: 'success' },
    { id: 'OPTIONAL', requiredness: 'optional', outcome: 'failure' },
  ]);
  expect(result.requirements.items).toMatchObject([{ title: 'ci', state: 'met' }]);
});

it('keeps non-check policies unavailable without enforcement evidence', () => {
  const scenario = setup({
    ...checkPolicy(-1, true),
    ...reviewPolicy,
    required_conversation_resolution: { enabled: true },
    required_deployments: { required_deployment_environments: ['production'] },
    required_signatures: { enabled: true },
  });
  scenario.facts.canBypassClassic = {
    data: null,
    source: { ...source, availability: 'unavailable', reason: 'permission' },
  };
  const rows = evaluate(scenario).requirements.items.filter(row => !row.check);
  expect(rows.map(row => [row.kind, row.state])).toEqual([
    ['branch-freshness', 'unavailable'],
    ['approving-reviews', 'unavailable'],
    ['conversation-resolution', 'unavailable'],
    ['deployment', 'unavailable'],
    ['commit-signatures', 'unavailable'],
  ]);
});

it('retains a retryable partial failure without inventing an unobserved check', () => {
  const policy = checkPolicy();
  policy.required_status_checks.contexts.push('build');
  policy.required_status_checks.checks.push({ context: 'build', app_id: -1 });
  const scenario = setup(policy);
  scenario.observations.head = collection([check(run('FAILED', 7, { conclusion: 'FAILURE' }))], {
    source: { ...source, availability: 'partial', retryable: true, reason: 'deadline' },
    completeness: 'partial',
    totalCount: null,
    hasNextPage: true,
    endCursor: 'NEXT',
  });
  const result = evaluate(scenario);
  expect(result.checks).toMatchObject({
    items: [{ id: 'FAILED', observation: 'observed', outcome: 'failure' }],
    source: { availability: 'partial', retryable: true, reason: 'deadline' },
    completeness: 'partial',
    totalCount: null,
    hasNextPage: true,
    endCursor: 'NEXT',
  });
  expect(
    result.requirements.items.filter(row => row.check).map(row => [row.title, row.state])
  ).toEqual([
    ['ci', 'unmet'],
    ['build', 'unavailable'],
  ]);
});

it('keeps denied check details unavailable without a retry or missing-check claim', () => {
  const scenario = setup();
  scenario.observations.head = collection([], {
    source: { ...source, availability: 'denied', reason: 'permission' },
    completeness: 'unknown',
    totalCount: null,
  });
  const result = evaluate(scenario);
  expect(result.checks).toMatchObject({
    items: [],
    source: { availability: 'denied', retryable: false, reason: 'permission' },
    completeness: 'unknown',
    totalCount: null,
  });
  expect(result.requirements.items.map(row => [row.kind, row.state])).toEqual([
    ['status-check', 'unavailable'],
    ['check-evaluation', 'unavailable'],
  ]);
});

it.each([null, { required_status_checks: { strict: true, contexts: [], checks: [] } }])(
  'reports confirmed empty requirements only from complete policy sources %j',
  policy => {
    const result = evaluate(setup(policy));
    expect(result.requirements).toMatchObject({
      items: [],
      source: { availability: 'available', retryable: false },
      completeness: 'complete',
      knownCount: 0,
      totalCount: 0,
    });
    expect(result.checks).toMatchObject({ items: [], completeness: 'complete', totalCount: 0 });
  }
);

it('does not create a requirement from a non-selected head check', () => {
  const scenario = setup();
  scenario.facts.testMerge = field({
    oid: 'merge',
    parents: { totalCount: 2, nodes: [{ oid: 'base' }, { oid: 'head' }] },
  });
  const headCheck = check(run('HEAD', 7, { conclusion: 'FAILURE' }));
  const mergeCheck = check(status('MERGE', { commit: { oid: 'merge' } }));
  scenario.observations.head = collection([headCheck]);
  scenario.observations.merge = collection([mergeCheck]);

  const result = evaluate(scenario);
  expect(result.requirements.items).toMatchObject([
    {
      state: 'met',
      check: { name: 'ci', kind: 'status', application: { kind: 'any' } },
      evidence: expect.arrayContaining([
        expect.objectContaining({
          source: 'graphql.checks',
          observation: 'check:MERGE:success',
          evaluatedSha: 'merge',
        }),
      ]),
    },
  ]);
  const selectionEvidence = expect.objectContaining({
    observation: 'head:head;test-merge:merge;selected:merge',
    evaluatedSha: 'merge',
  });
  expect(result.checks.items).toEqual([
    { ...headCheck, evidence: [...headCheck.evidence, selectionEvidence] },
    { ...mergeCheck, evidence: [...mergeCheck.evidence, selectionEvidence] },
  ]);
  expect(result.evaluatedShas).toEqual(['head', 'merge']);
});

it.each(['head', 'merge'] as const)(
  'retains unmatched required checks from the selected %s commit',
  sha => {
    const scenario = setup();
    const selectedChecks = collection([
      check(status('CURRENT', { commit: { oid: sha } })),
      check(status('UNMATCHED', { context: 'build', state: 'FAILURE', commit: { oid: sha } })),
    ]);
    if (sha === 'head') {
      scenario.observations.head = selectedChecks;
    } else {
      scenario.facts.testMerge = field({
        oid: 'merge',
        parents: { totalCount: 2, nodes: [{ oid: 'base' }, { oid: 'head' }] },
      });
      scenario.observations.merge = selectedChecks;
    }

    expect(evaluate(scenario).requirements.items).toMatchObject([
      { title: 'ci', state: 'met' },
      {
        id: 'github:isRequired:UNMATCHED',
        title: 'build',
        state: 'unavailable',
        evidence: expect.arrayContaining([
          expect.objectContaining({
            source: 'graphql.checks',
            policyId: 'github:isRequired:UNMATCHED',
            observation: 'check:UNMATCHED:failure',
            headSha: 'head',
            baseSha: 'base',
            evaluatedSha: sha,
          }),
        ]),
      },
    ]);
  }
);

it('keeps required observations unavailable when check-run-only merge selection is ambiguous', () => {
  const scenario = setup();
  scenario.facts.testMerge = field({
    oid: 'merge',
    parents: { totalCount: 2, nodes: [{ oid: 'base' }, { oid: 'head' }] },
  });
  const mergeRun = run('MERGE');
  mergeRun.checkSuite.commit.oid = 'merge';
  scenario.observations.head = collection([check(run('HEAD'))]);
  scenario.observations.merge = collection([check(mergeRun)]);

  const result = evaluate(scenario);
  expect(result.requirements.items).toMatchObject([
    { kind: 'status-check', state: 'unavailable' },
    { id: 'github:isRequired:HEAD', state: 'unavailable' },
    { id: 'github:isRequired:MERGE', state: 'unavailable' },
    { id: 'github:check-evaluation', state: 'unavailable' },
  ]);
  expect(result.checks).toMatchObject({
    items: [
      { id: 'HEAD', evaluatedSha: 'head' },
      { id: 'MERGE', evaluatedSha: 'merge' },
    ],
    source: { availability: 'partial', retryable: false, reason: 'check-source-ambiguous' },
    completeness: 'partial',
    totalCount: null,
  });
  for (const observed of result.checks.items)
    expect(observed.evidence).toContainEqual(
      expect.objectContaining({
        observation: 'head:head;test-merge:merge;selected:unavailable',
        evaluatedSha: null,
      })
    );
});

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
function review(
  id = 'REVIEW',
  actor = 'USER'
): GitHubPrReviewContext['reviewDecisions']['items'][number] {
  return {
    id,
    state: 'APPROVED',
    submittedAt: source.observedAt,
    commitSha: 'head',
    actor: {
      id: actor,
      kind: 'User',
      login: actor,
      name: null,
      avatarUrl: null,
      url: null,
      teamSlug: null,
    },
    onBehalfOf: collection([]),
  };
}
function reviewed() {
  const scenario = setup(reviewPolicy);
  scenario.observations.eligibleReviews = collection([review()]);
  scenario.context.reviewDecisions = collection([review()]);
  scenario.context.reviewActivity = collection([review()]);
  return scenario;
}
function deployed() {
  const scenario = setup(null, [
    {
      type: 'required_deployments',
      parameters: { required_deployment_environments: ['production'] },
    },
  ]);
  // Explicit normalized enforcement is an input, not proof of provider bypass semantics.
  for (const row of scenario.context.requirements.items)
    if (row.policy) {
      row.policy.viewerEnforcement = 'enforced';
      row.policy.viewerBypass = 'never';
    }
  scenario.observations.deployments = collection([
    {
      id: 'DEPLOY',
      commitOid: 'head',
      environment: 'production',
      latestStatus: { state: 'FAILURE' },
    },
  ]);
  return scenario;
}

it.each([
  [true, 'FAILURE', 'required', 'failure', 'unmet'],
  [false, 'FAILURE', 'optional', 'failure', 'unavailable'],
  [undefined, 'FAILURE', 'unknown', 'failure', 'unavailable'],
  [null, 'SUCCESS', 'unknown', 'success', 'unavailable'],
  [true, 'NEUTRAL', 'required', 'skipped', 'met'],
  [true, 'SKIPPED', 'required', 'skipped', 'met'],
  [true, 'NEW_CONCLUSION', 'required', 'unknown', 'unavailable'],
] as const)(
  'keeps requiredness %s separate from conclusion %s',
  (isRequired, conclusion, requiredness, outcome, state) => {
    const scenario = setup();
    scenario.observations.head = collection([check(run('RUN', 7, { isRequired, conclusion }))]);
    const result = evaluate(scenario);
    expect(result.checks.items[0]).toMatchObject({ requiredness, outcome, kind: 'check-run' });
    expect(result.requirements.items.find(row => row.check)?.state).toBe(state);
  }
);

it.each(['bypass', 'denied-bypass', 'unknown-context', 'no-policy'] as const)(
  'keeps known required failures unavailable without established enforcement: %s',
  condition => {
    const scenario = setup(condition === 'no-policy' ? null : checkPolicy());
    scenario.observations.head = collection([check(run('RUN', 7, { conclusion: 'FAILURE' }))]);
    if (condition === 'bypass') scenario.facts.canBypassClassic = field(true);
    if (condition === 'denied-bypass')
      scenario.facts.canBypassClassic = {
        data: null,
        source: { ...source, availability: 'denied' },
      };
    if (condition === 'unknown-context')
      scenario.facts.viewerRule.requiredStatusCheckContexts = field(null);
    const result = evaluate(scenario);
    expect(result.checks.items[0]).toMatchObject({ requiredness: 'required', outcome: 'failure' });
    expect(result.requirements.items.filter(row => row.check)).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'unavailable' })])
    );
    expect(result.requirements.items.some(row => row.state === 'unmet')).toBe(false);
  }
);

it.each([
  ['EXPECTED', 'pending', 'unmet'],
  ['PENDING', 'pending', 'unmet'],
  ['ERROR', 'failure', 'unmet'],
  ['SUCCESS', 'success', 'met'],
  ['NEW_STATE', 'unknown', 'unavailable'],
] as const)('preserves the observed status state %s', (state, outcome, requirementState) => {
  const scenario = setup();
  scenario.observations.head = collection([check(status('STATUS', { state }))]);
  const result = evaluate(scenario);
  expect(result.checks.items[0]).toMatchObject({ kind: 'status', status: state, outcome });
  expect(result.requirements.items[0]?.state).toBe(requirementState);
});

it('matches application IDs instead of equal display names and retains optional failures', () => {
  const scenario = setup(checkPolicy(7));
  scenario.observations.head = collection([
    check(run('OTHER', 8, { isRequired: false, conclusion: 'FAILURE' })),
    check(run('BOUND', 7)),
  ]);
  const result = evaluate(scenario);
  expect(result.checks.items).toMatchObject([
    {
      id: 'OTHER',
      application: { id: 8, name: 'Same display name' },
      outcome: 'failure',
      requiredness: 'optional',
    },
    { id: 'BOUND', application: { id: 7, name: 'Same display name' } },
  ]);
  expect(result.requirements.items.filter(row => row.check)).toMatchObject([
    { state: 'met', check: { application: { kind: 'app', appId: 7 } } },
  ]);
  expect(result.requirements.items.some(row => row.state === 'unmet')).toBe(false);
});

it.each([null, 0])(
  'does not normalize the undocumented application binding %s to a wildcard',
  app_id => {
    const scenario = setup(checkPolicy(app_id));
    scenario.observations.head = collection([check(run('RUN'))]);
    expect(
      evaluate(scenario).requirements.items.find(
        row => row.policy?.source === 'classic' && row.check
      )
    ).toMatchObject({ state: 'unavailable', check: { application: { kind: 'unknown' } } });
  }
);

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

it('does not use a status creator or an inaccessible app to satisfy an application-bound policy', () => {
  const scenario = setup(checkPolicy(7));
  scenario.observations.head = collection([
    check(status('STATUS', { creator: { id: 7, login: 'app-7' } })),
    check(run('RUN', 7, { checkSuite: { app: null, commit: { oid: 'head' } } })),
  ]);
  const result = evaluate(scenario);
  expect(
    result.requirements.items.find(row => row.policy?.source === 'classic' && row.check)?.state
  ).toBe('unavailable');
  expect(result.checks.items.every(item => item.application === null)).toBe(true);
  expect(result.checks.items.some(item => item.observation === 'missing')).toBe(false);
});

it.each([7, 8])(
  'preserves duplicate names from app %s without guessing the latest run',
  secondApp => {
    const scenario = setup();
    scenario.observations.head = collection([
      check(run('FIRST', 7)),
      check(run('SECOND', secondApp, { conclusion: 'FAILURE' })),
    ]);
    expect(requirements(scenario, 'status-check').map(row => row.state)).toEqual(
      secondApp === 7 ? ['unavailable', 'unavailable'] : ['met', 'unmet']
    );
  }
);

it.each([
  'complete',
  'policy-partial',
  'checks-partial',
  'next-page',
  'denied',
  'unknown-bypass',
] as const)(
  'reports missing observations only with complete applicable evidence: %s',
  condition => {
    const scenario = setup();
    if (condition === 'policy-partial') scenario.context.requirements.completeness = 'partial';
    if (condition === 'checks-partial') scenario.observations.head.completeness = 'partial';
    if (condition === 'next-page') scenario.observations.head.hasNextPage = true;
    if (condition === 'denied')
      scenario.observations.head.source = { ...source, availability: 'denied', retryable: false };
    if (condition === 'unknown-bypass')
      scenario.facts.canBypassClassic = {
        data: null,
        source: { ...source, availability: 'unavailable' },
      };
    const result = evaluate(scenario);
    expect(result.checks.items.filter(item => item.observation === 'missing')).toHaveLength(
      condition === 'complete' ? 1 : 0
    );
    expect(result.requirements.items.find(row => row.check)?.state).toBe(
      condition === 'complete' ? 'unmet' : 'unavailable'
    );
  }
);

it('retains a directly observed failure when a later check page is unavailable', () => {
  const scenario = setup();
  scenario.observations.head = collection([check(run('RUN', 7, { conclusion: 'FAILURE' }))], {
    completeness: 'partial',
    totalCount: 2,
    hasNextPage: true,
    source: { ...source, availability: 'partial', retryable: true, reason: 'bad_gateway' },
  });
  const result = evaluate(scenario);
  expect(result.checks.source).toMatchObject({ availability: 'partial', retryable: true });
  expect(result.requirements.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ kind: 'status-check', state: 'unmet' }),
      expect.objectContaining({ kind: 'check-evaluation', state: 'unavailable' }),
    ])
  );
});

it.each(['status', 'empty', 'run-only', 'partial', 'wrong-parents', 'head-only-context'] as const)(
  'uses documented commit selection without inventing fallback: %s',
  condition => {
    const scenario = setup();
    scenario.facts.testMerge = field({
      oid: 'merge',
      parents: {
        totalCount: 2,
        nodes: [{ oid: 'head' }, { oid: condition === 'wrong-parents' ? 'old-base' : 'base' }],
      },
    });
    scenario.observations.head = collection([check(run('HEAD', 7, { conclusion: 'FAILURE' }))]);
    const mergeCheck =
      condition === 'run-only'
        ? check(run('MERGE', 7, { checkSuite: { app: null, commit: { oid: 'merge' } } }))
        : check(
            status('MERGE', {
              context: condition === 'head-only-context' ? 'other' : 'ci',
              commit: { oid: 'merge' },
              isRequired: condition !== 'head-only-context',
            })
          );
    scenario.observations.merge = collection(condition === 'empty' ? [] : [mergeCheck]);
    if (condition === 'partial') {
      scenario.observations.merge = collection([], { completeness: 'partial', totalCount: null });
    }
    const result = evaluate(scenario);
    expect(result.evaluatedShas).toEqual(['head', 'merge']);
    expect(result.checks.items[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          observation: expect.stringContaining('head:head;test-merge:merge;selected:'),
        }),
      ])
    );
    const bound = result.requirements.items.filter(
      row => row.policy?.source === 'classic' && row.check
    );
    expect(bound[0]?.state).toBe(
      condition === 'status' ? 'met' : condition === 'empty' ? 'unmet' : 'unavailable'
    );
    if (condition !== 'empty')
      expect(result.requirements.items.some(row => row.state === 'unmet')).toBe(false);
    if (condition === 'head-only-context')
      expect(result.checks.items.some(item => item.observation === 'missing')).toBe(false);
  }
);

it.each(['missing', 'old-head', 'old-base', 'missing-time'] as const)(
  'rejects incomplete or stale direct check evidence: %s',
  condition => {
    const scenario = setup();
    const observed = check(run('RUN', 7, { conclusion: 'FAILURE' }));
    if (condition === 'missing') observed.evidence = [];
    for (const entry of observed.evidence) {
      if (condition === 'old-head') entry.headSha = 'old-head';
      if (condition === 'old-base') entry.baseSha = 'old-base';
      if (condition === 'missing-time') entry.observedAt = null;
    }
    scenario.observations.head = collection([observed]);
    expect(requirements(scenario, 'status-check')[0]?.state).toBe('unavailable');
  }
);

it('does not satisfy a policy with an observation of unknown kind', () => {
  const scenario = setup();
  const observed = check(run('RUN'));
  observed.kind = 'unknown';
  scenario.observations.head = collection([observed]);
  expect(requirements(scenario, 'status-check')[0]?.state).toBe('unavailable');
});

it('does not use an old check commit as current failure evidence', () => {
  const scenario = setup();
  scenario.observations.head = collection([
    check(status('OLD', { state: 'FAILURE', commit: { oid: 'old-head' } })),
  ]);
  expect(requirements(scenario, 'status-check')[0]?.state).toBe('unavailable');
});

it.each([
  'known',
  'enough',
  'unknown-actor',
  'old-commit',
  'partial',
  'inconsistent',
  'code-owner',
  'dismissal',
  'last-push',
  'unknown-flags',
  'unknown-enforcement',
] as const)('counts only current eligible and enforced reviews: %s', condition => {
  const scenario = reviewed();
  if (condition === 'enough') {
    scenario.observations.eligibleReviews = collection([review(), review('SECOND', 'USER_2')]);
    scenario.context.reviewDecisions = collection([review(), review('SECOND', 'USER_2')]);
    scenario.context.reviewActivity = collection([review(), review('SECOND', 'USER_2')]);
  }
  if (condition === 'unknown-actor') scenario.observations.eligibleReviews.items[0]!.actor = null;
  if (condition === 'old-commit') scenario.observations.eligibleReviews.items[0]!.commitSha = 'old';
  if (condition === 'partial') scenario.observations.eligibleReviews.completeness = 'partial';
  if (condition === 'inconsistent') scenario.context.reviewDecisions.items[0]!.state = 'DISMISSED';
  const parametersByCondition: Record<string, string> = {
    'code-owner': 'require_code_owner_reviews',
    dismissal: 'dismiss_stale_reviews',
    'last-push': 'require_last_push_approval',
    'unknown-flags': 'dismiss_stale_reviews',
  };
  const parameter = parametersByCondition[condition];
  if (parameter) {
    for (const row of scenario.context.requirements.items) {
      const parameters = row.policy?.parameters?.required_pull_request_reviews as Record<
        string,
        unknown
      >;
      parameters[parameter] = condition === 'unknown-flags' ? null : true;
    }
  }
  if (condition === 'unknown-enforcement')
    scenario.facts.viewerRule.requiredApprovingReviewCount = {
      data: null,
      source: { ...source, availability: 'denied' },
    };
  expect(requirements(scenario, 'approving-reviews')[0]?.state).toBe(
    condition === 'known' ? 'unmet' : condition === 'enough' ? 'met' : 'unavailable'
  );
});

it.each([
  'failed',
  'successful',
  'other-environment',
  'other-commit',
  'partial',
  'unknown-bypass',
  'multiple',
] as const)('matches deployments to the required environment and commit: %s', condition => {
  const scenario = deployed();
  const deployment = scenario.observations.deployments.items[0]!;
  if (condition === 'successful') deployment.latestStatus = { state: 'SUCCESS' };
  if (condition === 'other-environment') deployment.environment = 'preview';
  if (condition === 'other-commit') deployment.commitOid = 'old';
  if (condition === 'partial') scenario.observations.deployments.completeness = 'partial';
  if (condition === 'multiple')
    scenario.observations.deployments = collection([deployment, { ...deployment, id: 'OTHER' }]);
  if (condition === 'unknown-bypass')
    scenario.context.requirements.items[0]!.policy!.viewerBypass = 'unknown';
  const row = requirements(scenario, 'deployment')[0];
  expect(row?.state).toBe(
    condition === 'failed' ? 'unmet' : condition === 'successful' ? 'met' : 'unavailable'
  );
  if (condition.startsWith('other'))
    expect(row?.evidence.some(entry => entry.observation.includes('DEPLOY'))).toBe(false);
  if (condition === 'multiple')
    expect(
      row?.evidence.some(
        entry =>
          entry.observation.includes('deployment:DEPLOY;') &&
          entry.observation.includes('deployment:OTHER;')
      )
    ).toBe(true);
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

it.each(['current', 'base', 'head', 'viewer', 'retryable', 'denied'] as const)(
  'requires matching comparison and viewer enforcement for freshness: %s',
  condition => {
    const scenario = setup(checkPolicy(-1, true));
    if (condition === 'base') scenario.facts.comparison.data!.baseTarget.oid = 'old-base';
    if (condition === 'head') scenario.facts.comparison.data!.headTarget.oid = 'old-head';
    if (condition === 'viewer') scenario.facts.viewerRule.requiredStatusCheckContexts = field([]);
    if (condition === 'retryable' || condition === 'denied')
      scenario.facts.comparison.source = {
        ...source,
        availability: condition === 'retryable' ? 'unavailable' : 'denied',
        retryable: condition === 'retryable',
        reason: condition === 'retryable' ? 'transient' : 'permission',
      };
    expect(requirements(scenario, 'branch-freshness')).toMatchObject([
      { state: condition === 'current' ? 'met' : 'unavailable' },
    ]);
  }
);

it.each([
  [false, false, 'unmet', 'observed-unresolved-thread-ids:THREAD'],
  [false, true, 'unmet', 'unresolved-threads:1;ids:THREAD'],
  [true, false, 'unavailable', 'conversation-observations-incomplete'],
  [true, true, 'met', 'unresolved-threads:0;ids:'],
  [null, true, 'unavailable', 'conversation-observations-incomplete'],
] as const)(
  'retains thread evidence for resolution %s with complete pages %s',
  (isResolved, completePages, state, observation) => {
    const scenario = setup({ required_conversation_resolution: { enabled: true } });
    scenario.observations.threads = collection(
      isResolved === true ? [] : [{ id: 'THREAD', isResolved }],
      completePages
        ? {}
        : {
            completeness: 'partial',
            hasNextPage: true,
            totalCount: null,
            source: { ...source, availability: 'partial', retryable: true, reason: 'deadline' },
          }
    );
    expect(requirements(scenario, 'conversation-resolution')).toMatchObject([
      { state, evidence: expect.arrayContaining([expect.objectContaining({ observation })]) },
    ]);
  }
);

it('retains current policy and direct evidence for each non-check failure', () => {
  const scenario = setup({
    ...checkPolicy(-1, true),
    ...reviewPolicy,
    required_conversation_resolution: { enabled: true },
    required_deployments: { required_deployment_environments: ['production'] },
  });
  scenario.observations.head = collection([check(run('PASS'))]);
  scenario.facts.comparison.data!.behindBy = 2;
  scenario.observations.threads = collection([{ id: 'THREAD', isResolved: false }]);
  scenario.observations.eligibleReviews = collection([review()]);
  scenario.context.reviewDecisions = collection([review()]);
  scenario.context.reviewActivity = collection([review()]);
  scenario.observations.deployments = deployed().observations.deployments;
  const unmet = evaluate(scenario).requirements.items.filter(row => row.state === 'unmet');
  expect(unmet.map(row => row.kind)).toEqual([
    'branch-freshness',
    'approving-reviews',
    'conversation-resolution',
    'deployment',
  ]);
  for (const [index, observation] of [
    'branch-behind:2',
    'eligible-approvals:1/2;ids:REVIEW',
    'unresolved-threads:1;ids:THREAD',
    'deployment:DEPLOY;environment:production;state:FAILURE',
  ].entries()) {
    const row = unmet[index]!;
    expect(row.policy).toMatchObject({
      enforcement: 'active',
      base: { baseRepoFullName: 'o/r', baseRef: 'release', baseSha: 'base' },
      viewerEnforcement: 'enforced',
      viewerBypass: 'never',
    });
    expect(row.evidence).toContainEqual(
      expect.objectContaining({
        source: 'graphql.observation',
        policyId: row.policy!.id,
        observation,
        headSha: 'head',
        baseSha: 'base',
        evaluatedSha: 'head',
        observedAt: source.observedAt,
      })
    );
  }
});

it('retains every viewer-policy contradiction instead of confirming no requirements', () => {
  const scenario = setup(null);
  scenario.facts.viewerRule.requiredStatusCheckContexts = field(['ci']);
  scenario.facts.viewerRule.requiredApprovingReviewCount = field(2);
  scenario.facts.viewerRule.requiresConversationResolution = field(true);
  const rows = evaluate(scenario).requirements.items;
  expect(rows).toMatchObject([{ kind: 'policy-evaluation', state: 'unavailable' }]);
  expect(rows[0]?.evidence.map(entry => entry.observation)).toEqual([
    'policy-source-conflict:status-checks',
    'policy-source-conflict:approving-reviews',
    'policy-source-conflict:conversations',
  ]);
});

function allNonCheckRequirements() {
  const scenario = setup({
    ...checkPolicy(-1, true),
    ...reviewPolicy,
    required_conversation_resolution: { enabled: true },
    required_deployments: { required_deployment_environments: ['production'] },
  });
  scenario.observations.head = collection([check(run('PASS'))]);
  scenario.observations.deployments = deployed().observations.deployments;
  return scenario;
}

describe.each([
  { availability: 'unavailable', retryable: true, reason: 'transient' },
  { availability: 'denied', retryable: false, reason: 'permission' },
] as const)('source recovery for $availability', failure => {
  it.each([
    ['comparison', 'branch-freshness'],
    ['threads', 'conversation-resolution'],
    ['eligibleReviews', 'approving-reviews'],
    ['deployments', 'deployment'],
  ] as const)('retains %s metadata and successful siblings', (key, kind) => {
    for (const provenance of [[`graphql.${key}`], []]) {
      const scenario = allNonCheckRequirements();
      const before = evaluate(scenario);
      const failed = { ...source, ...failure, provenance };
      const inputs = {
        comparison: scenario.facts.comparison,
        threads: scenario.observations.threads,
        eligibleReviews: scenario.observations.eligibleReviews,
        deployments: scenario.observations.deployments,
      };
      inputs[key].source = failed;
      const result = evaluate(scenario);
      expect(result.evaluationSources[key]).toStrictEqual(failed);
      expect(result.requirements.items.filter(row => row.kind === kind)).toMatchObject([
        { state: 'unavailable' },
      ]);
      expect(result.requirements.items.filter(row => row.kind !== kind)).toStrictEqual(
        before.requirements.items.filter(row => row.kind !== kind)
      );
      expect(result.requirements.source).toStrictEqual(before.requirements.source);
    }
  });

  it.each([
    [
      'canBypassClassic',
      [
        'branch-freshness',
        'approving-reviews',
        'conversation-resolution',
        'deployment',
        'status-check',
      ],
    ],
    ['requiredStatusCheckContexts', ['branch-freshness', 'status-check']],
    ['requiredApprovingReviewCount', ['approving-reviews']],
    ['requiresConversationResolution', ['conversation-resolution']],
    ['reviewDecisions', ['approving-reviews']],
    ['reviewActivity', ['approving-reviews']],
  ] as const)('retains the failed %s dependency without hiding siblings', (key, kinds) => {
    for (const provenance of [[`graphql.${key}`], []]) {
      const scenario = allNonCheckRequirements();
      const before = evaluate(scenario);
      const failed = { ...source, ...failure, provenance };
      const inputs = {
        canBypassClassic: scenario.facts.canBypassClassic,
        ...scenario.facts.viewerRule,
        reviewDecisions: scenario.context.reviewDecisions,
        reviewActivity: scenario.context.reviewActivity,
      };
      inputs[key].source = failed;
      const result = evaluate(scenario);
      expect(result.evaluationSources[key]).toStrictEqual(failed);
      const affected = result.requirements.items.filter(row =>
        kinds.some(kind => kind === row.kind)
      );
      expect(affected.map(row => [row.kind, row.state])).toEqual(
        expect.arrayContaining(kinds.map(kind => [kind, 'unavailable']))
      );
      expect(
        result.requirements.items.filter(row => !kinds.some(kind => kind === row.kind))
      ).toStrictEqual(
        before.requirements.items.filter(row => !kinds.some(kind => kind === row.kind))
      );
    }
  });

  it('retains unavailable mergeability without discarding non-check policy results', () => {
    const scenario = allNonCheckRequirements();
    const before = evaluate(scenario);
    const failed = { ...source, ...failure, provenance: [] };
    scenario.facts.mergeable = { data: null, source: failed };
    const result = evaluate(scenario);
    expect(result.evaluationSources.mergeable).toStrictEqual(failed);
    expect(result.requirements.items.filter(row => row.kind === 'merge-conflicts')).toMatchObject([
      { state: 'unavailable' },
    ]);
    expect(result.requirements.items.filter(row => row.kind !== 'merge-conflicts')).toStrictEqual(
      before.requirements.items
    );
  });
});

it('retains simultaneous transient and denied evaluation sources independently', () => {
  const scenario = allNonCheckRequirements();
  scenario.facts.comparison.source = {
    ...source,
    availability: 'unavailable',
    retryable: true,
    reason: 'transient',
    provenance: [],
  };
  scenario.observations.threads.source = {
    ...source,
    availability: 'denied',
    reason: 'permission',
    provenance: [],
  };
  const result = evaluate(scenario);
  expect(result.evaluationSources).toMatchObject({
    comparison: { availability: 'unavailable', retryable: true, reason: 'transient' },
    threads: { availability: 'denied', retryable: false, reason: 'permission' },
    deployments: { availability: 'available', retryable: false, reason: null },
  });
  expect(result.requirements.items.map(row => [row.kind, row.state])).toEqual([
    ['branch-freshness', 'unavailable'],
    ['approving-reviews', 'unmet'],
    ['conversation-resolution', 'unavailable'],
    ['deployment', 'unmet'],
    ['status-check', 'met'],
  ]);
});

it('retains retry metadata beside a directly observed unresolved thread', () => {
  const scenario = allNonCheckRequirements();
  const partial = {
    ...source,
    availability: 'partial' as const,
    retryable: true,
    reason: 'deadline',
  };
  scenario.observations.threads = collection([{ id: 'THREAD', isResolved: false }], {
    source: partial,
    completeness: 'partial',
    totalCount: null,
    hasNextPage: true,
  });
  const result = evaluate(scenario);
  expect(result.evaluationSources.threads).toStrictEqual(partial);
  expect(
    result.requirements.items.find(row => row.kind === 'conversation-resolution')
  ).toMatchObject({
    state: 'unmet',
    evidence: expect.arrayContaining([
      expect.objectContaining({ observation: 'observed-unresolved-thread-ids:THREAD' }),
    ]),
  });
});

import {
  GitHubPrReviewApplicationBindingSchema,
  GitHubPrReviewContextSchema,
  GitHubPrReviewRequirementSchema,
} from './context-dtos';
import {
  GitHubPrReviewChecksResultSchema,
  GitHubPrReviewInboxItemSchema,
  GitHubPrReviewInboxResultSchema,
  GitHubPrReviewOverviewSchema,
  GitHubPrReviewReviewCommentSchema,
  NormalizedGitHubPrReviewInboxItemSchema,
  NormalizedGitHubPrReviewInboxResultSchema,
  NormalizedGitHubPrReviewOverviewSchema,
} from './dtos';

const author = { login: 'octocat', avatarUrl: null };
const oldOverview = {
  number: 12,
  title: 'Fix',
  bodyMarkdown: null,
  author,
  state: 'open',
  draft: false,
  baseRef: 'main',
  headRef: 'fix',
  isCrossRepo: false,
  headRepoFullName: null,
  headSha: 'head',
  prNodeId: 'PR_12',
  counts: { commits: 1, changedFiles: 1, additions: 2, deletions: 0 },
  mergeable: null,
  mergeableState: null,
  autoMerge: null,
  reviewDecision: null,
  repo: {
    allowMergeCommit: false,
    allowSquashMerge: false,
    allowRebaseMerge: false,
    allowAutoMerge: false,
    deleteBranchOnMerge: false,
    allowUpdateBranch: false,
    viewerCanPush: false,
    viewerCanAdmin: false,
    viewerLogin: null,
  },
};
const oldInbox = {
  owner: 'kilo',
  repo: 'flux',
  number: 12,
  title: 'Fix',
  author,
  isDraft: false,
  updatedAt: '',
};
const revision = {
  prNodeId: 'PR_12',
  number: 12,
  headSha: 'head',
  baseRepoFullName: 'kilo/flux',
  baseRef: 'main',
  baseSha: 'base',
};
const observedAt = '2026-08-28T12:00:00+02:00';
const source = {
  availability: 'available',
  retryable: false,
  provenance: ['graphql'],
  reason: null,
  observedAt,
};
const complete = <T>(items: T[]) => ({
  source,
  items,
  completeness: 'complete',
  knownCount: items.length,
  totalCount: items.length,
  hasNextPage: false,
  endCursor: null,
});

const identity = {
  id: 'U_1',
  kind: 'User',
  login: 'octocat',
  name: 'Octo Cat',
  avatarUrl: null,
  url: null,
  teamSlug: null,
};
const evidence = [
  {
    source: 'graphql.checks',
    policyId: 'rule-1',
    observation: 'failure',
    headSha: 'head',
    baseSha: 'base',
    evaluatedSha: 'head',
    observedAt,
  },
];
const legacyPolicy = { id: 'rule-1', source: 'classic', enforcement: 'active' };
const policyDefaults = {
  base: null,
  ruleType: null,
  parameters: null,
  ruleset: null,
  viewerEnforcement: 'unknown',
  viewerBypass: 'unknown',
  bypassActors: null,
};
const legacyRequirement = {
  id: 'rule-1',
  kind: 'status-check',
  title: 'CI',
  state: 'unmet',
  policy: legacyPolicy,
  check: { name: 'ci', kind: 'check-run', application: { kind: 'app', appId: 1 } },
  evidence,
};
const fullContext = {
  revision,
  observedAt,
  evaluatedShas: ['head'],
  evaluationSources: {
    mergeable: source,
    testMerge: source,
    comparison: source,
    canBypassClassic: source,
    requiredApprovingReviewCount: source,
    requiredStatusCheckContexts: source,
    requiresConversationResolution: source,
    threads: source,
    eligibleReviews: source,
    reviewDecisions: source,
    reviewActivity: source,
    deployments: source,
  },
  labels: complete([{ id: 'L_1', name: 'bug', color: null }]),
  assignees: complete([identity]),
  reviewRequests: complete([
    {
      id: 'RR_1',
      reviewer: {
        ...identity,
        id: 'T_1',
        kind: 'Team',
        login: null,
        name: 'Core',
        teamSlug: 'core',
      },
    },
  ]),
  reviewDecisions: complete([
    {
      id: 'R_1',
      actor: identity,
      state: 'APPROVED',
      submittedAt: observedAt,
      commitSha: 'head',
      onBehalfOf: complete([]),
    },
  ]),
  reviewActivity: complete([
    {
      id: 'R_2',
      actor: null,
      state: 'COMMENTED',
      submittedAt: null,
      commitSha: null,
      onBehalfOf: complete([]),
    },
  ]),
  lifecycle: {
    source,
    openedAt: '2026-01-01T12:00:00+01:00',
    updatedAt: observedAt,
    closedAt: null,
    mergedAt: null,
  },
  merger: { source, identity: null },
  issues: complete([
    {
      id: 'I_1',
      number: 7,
      title: 'Issue',
      state: 'OPEN',
      repository: 'other/flux',
      url: 'https://github.com/other/flux/issues/7',
      relationships: [
        {
          category: 'connected',
          membership: 'current',
          evidenceId: 'E_1',
          sourceId: 'PR_12',
          targetId: 'I_1',
        },
      ],
    },
  ]),
  issueCoverage: 'supported-pr-sources',
  requirements: complete([
    { ...legacyRequirement, policy: { ...legacyPolicy, ...policyDefaults } },
  ]),
  checks: complete([
    {
      id: 'C_1',
      name: 'ci',
      kind: 'check-run',
      application: { id: 1, nodeId: 'APP_1', slug: 'ci', name: 'CI' },
      outcome: 'failure',
      status: 'completed',
      conclusion: 'failure',
      requiredness: 'required',
      observation: 'observed',
      evaluatedSha: 'head',
      detailsUrl: null,
      evidence,
    },
    {
      id: null,
      name: 'ci',
      kind: 'status',
      application: null,
      outcome: 'unknown',
      status: null,
      conclusion: null,
      requiredness: 'required',
      observation: 'missing',
      evaluatedSha: 'head',
      detailsUrl: null,
      evidence,
    },
  ]),
  queue: {
    membership: { source, state: 'queued', entryId: 'Q_1' },
    position: {
      source,
      entryId: 'Q_1',
      prNodeId: 'PR_12',
      value: 3,
      state: 'QUEUED',
      enqueuedAt: observedAt,
    },
  },
};

test.each(['active', 'evaluate', 'disabled', 'unknown'])(
  'normalizes legacy policies with %s enforcement without inventing evidence',
  enforcement => {
    const input = { ...legacyRequirement, policy: { ...legacyPolicy, enforcement } };
    expect(GitHubPrReviewRequirementSchema.parse(input)).toStrictEqual({
      ...input,
      policy: { ...input.policy, ...policyDefaults },
    });
  }
);

test.each([
  [
    'pull_request',
    {
      required_approving_review_count: 2,
      require_code_owner_review: true,
      require_last_push_approval: true,
      dismiss_stale_reviews_on_push: true,
      required_review_thread_resolution: true,
    },
  ],
  [
    'required_status_checks',
    {
      strict_required_status_checks_policy: true,
      required_status_checks: [{ context: 'ci', integration_id: 7 }, { context: 'unbound' }],
    },
  ],
  ['required_deployments', { required_deployment_environments: ['production'] }],
  ['required_signatures', {}],
  [
    'workflows',
    {
      workflows: [
        {
          repository_id: 42,
          path: '.github/workflows/ci.yml',
          ref: 'release',
          sha: 'workflow-sha',
        },
      ],
    },
  ],
  ['future_rule', { nested: [{ enabled: false, limit: 3, label: 'opaque', value: null }] }],
])('retains %s policy evidence without evaluating it', (ruleType, parameters) => {
  const input = {
    ...legacyRequirement,
    state: 'unavailable',
    check: null,
    evidence: [],
    policy: {
      ...legacyPolicy,
      ...policyDefaults,
      source: 'ruleset',
      ruleType,
      parameters,
      base: { baseRepoFullName: 'kilo/upstream', baseRef: 'release/1', baseSha: 'release-sha' },
      ruleset: { id: 7, source: 'kilo', sourceType: 'Organization' },
      bypassActors: [{ actorId: 7, actorType: 'Integration', bypassMode: 'pull_request' }],
    },
  };
  const { context } = NormalizedGitHubPrReviewOverviewSchema.parse({
    ...oldOverview,
    context: { revision, requirements: complete([input]) },
  });
  expect(context.requirements.items).toStrictEqual([input]);
});

test.each([
  ['enforced', 'never'],
  ['not-enforced', 'always'],
  ['unknown', 'pull_requests_only'],
  ['not-enforced', 'exempt'],
  ['unknown', 'unknown'],
])(
  'retains viewer enforcement %s and bypass %s independently',
  (viewerEnforcement, viewerBypass) => {
    const policy = {
      ...legacyPolicy,
      ...policyDefaults,
      viewerEnforcement,
      viewerBypass,
      bypassActors: [],
    };
    expect(
      GitHubPrReviewRequirementSchema.parse({ ...legacyRequirement, policy }).policy
    ).toStrictEqual(policy);
  }
);

test('preserves nullable policy identities without inventing bypass or check bindings', () => {
  const absent = { ...legacyRequirement, policy: null, check: null };
  expect(GitHubPrReviewRequirementSchema.parse(absent)).toStrictEqual(absent);
  const policy = {
    ...legacyPolicy,
    ...policyDefaults,
    base: { baseRepoFullName: null, baseRef: 'release/1', baseSha: null },
    ruleset: {},
    bypassActors: [{ actorType: 'DeployKey' }],
  };
  expect(GitHubPrReviewRequirementSchema.parse({ ...absent, policy }).policy).toStrictEqual({
    ...policy,
    ruleset: { id: null, source: null, sourceType: null },
    bypassActors: [{ actorType: 'DeployKey', actorId: null, bypassMode: 'unknown' }],
  });
});

test.each([
  ['encoded parameters', { parameters: '{"required_approving_review_count":2}' }],
  ['undefined parameter values', { parameters: { nested: [undefined] } }],
  ['function parameter values', { parameters: { nested: { callback: () => true } } }],
  ['non-finite parameter values', { parameters: { limit: Infinity } }],
  ['invalid base identity', { base: { baseRepoFullName: null, baseRef: 'release', baseSha: 17 } }],
  ['empty rule type', { ruleType: '' }],
  ['invalid ruleset identity', { ruleset: { id: -1 } }],
  ['invalid ruleset source type', { ruleset: { sourceType: 'User' } }],
  ['invalid viewer enforcement', { viewerEnforcement: 'active' }],
  ['invalid viewer bypass', { viewerBypass: 'allowed' }],
  ['invalid actor identity', { bypassActors: [{ actorType: 'Team', actorId: '12' }] }],
  ['invalid actor type', { bypassActors: [{ actorType: 'User' }] }],
  ['invalid bypass mode', { bypassActors: [{ actorType: 'Team', bypassMode: 'never' }] }],
])('rejects %s in structured policy evidence', (_name, invalid) => {
  expect(
    GitHubPrReviewRequirementSchema.safeParse({
      ...legacyRequirement,
      policy: { ...legacyPolicy, ...invalid },
    }).success
  ).toBe(false);
});

test.each([
  ['partial', true],
  ['stale', true],
  ['unavailable', true],
  ['denied', false],
])(
  'preserves policy evidence and retryability when its source is %s',
  (availability, retryable) => {
    const requirements = {
      ...fullContext.requirements,
      source: { ...source, availability, retryable, reason: 'policy-source-failure' },
      completeness: 'unknown',
    };
    const context = GitHubPrReviewContextSchema.parse({
      revision,
      requirements,
      labels: complete([]),
    });
    expect(context.requirements).toStrictEqual(requirements);
    expect(context.labels).toStrictEqual(complete([]));
  }
);

test('normalizes omitted sources without claiming complete empty collections', () => {
  const context = GitHubPrReviewContextSchema.parse({ revision });
  for (const collection of [
    context.labels,
    context.assignees,
    context.reviewRequests,
    context.reviewDecisions,
    context.reviewActivity,
    context.issues,
    context.requirements,
    context.checks,
  ]) {
    expect(collection).toMatchObject({
      source: { availability: 'unavailable', reason: 'not-requested', retryable: false },
      items: [],
      completeness: 'unknown',
      knownCount: 0,
      totalCount: null,
      hasNextPage: null,
      endCursor: null,
    });
  }
  expect(context).toMatchObject({
    revision,
    observedAt: null,
    evaluatedShas: [],
    lifecycle: { openedAt: null, updatedAt: null, closedAt: null, mergedAt: null },
    merger: { identity: null },
    queue: { membership: { state: 'unknown' }, position: { value: null } },
  });
});

test('preserves successful siblings, exact lifecycle times, and confirmed emptiness', () => {
  const labels = complete([{ id: 'L_1', name: 'bug', color: null }]);
  const lifecycle = {
    source,
    openedAt: observedAt,
    updatedAt: observedAt,
    closedAt: null,
    mergedAt: null,
  };
  const input = {
    revision,
    labels,
    lifecycle,
    assignees: complete([]),
    requirements: complete([]),
  };
  expect(GitHubPrReviewContextSchema.parse(input)).toMatchObject(input);
});

test.each([
  ['partial', true],
  ['stale', true],
  ['unavailable', true],
  ['denied', false],
])('preserves queued membership when position is %s', (availability, retryable) => {
  const queue = {
    membership: { source, state: 'queued', entryId: 'Q_1' },
    position: {
      source: { ...source, availability, retryable, reason: 'source-failure' },
      entryId: 'Q_1',
      prNodeId: 'PR_12',
      value: null,
      state: null,
      enqueuedAt: null,
    },
  };
  const context = GitHubPrReviewContextSchema.parse({ revision, queue, labels: complete([]) });
  expect(context.queue).toEqual(queue);
  expect(context.labels).toEqual(complete([]));

  const input = {
    ...fullContext,
    queue: {
      ...fullContext.queue,
      position: {
        ...fullContext.queue.position,
        source: queue.position.source,
        value: null,
      },
    },
  };
  expect(
    NormalizedGitHubPrReviewOverviewSchema.parse({ ...oldOverview, context: input }).context
  ).toStrictEqual(input);
});

test.each([{ kind: 'app', appId: 1 }, { kind: 'any' }, { kind: 'unknown' }])(
  'preserves the explicit application binding %j',
  binding => {
    expect(GitHubPrReviewApplicationBindingSchema.parse(binding)).toEqual(binding);
    const check = { ...legacyRequirement.check, application: binding };
    expect(
      GitHubPrReviewRequirementSchema.parse({ ...legacyRequirement, check }).check
    ).toStrictEqual(check);
  }
);

test.each([null, undefined, 0])('rejects an invalid bound application ID: %s', appId => {
  expect(GitHubPrReviewApplicationBindingSchema.safeParse({ kind: 'app', appId }).success).toBe(
    false
  );
});

test('accepts old overview and Inbox payloads without altering legacy fields', () => {
  expect(GitHubPrReviewOverviewSchema.parse(oldOverview)).toStrictEqual(oldOverview);
  expect(GitHubPrReviewInboxItemSchema.parse(oldInbox)).toStrictEqual(oldInbox);
  const { context, ...legacy } = NormalizedGitHubPrReviewOverviewSchema.parse(oldOverview);
  expect(legacy).toStrictEqual(oldOverview);
  expect(context.revision).toStrictEqual({ ...revision, baseSha: null, baseRepoFullName: null });
  for (const collection of [
    context.labels,
    context.assignees,
    context.reviewRequests,
    context.reviewDecisions,
    context.reviewActivity,
    context.issues,
    context.requirements,
    context.checks,
  ]) {
    expect(collection).toMatchObject({
      source: { availability: 'unavailable', reason: 'not-requested', retryable: false },
      items: [],
      completeness: 'unknown',
      knownCount: 0,
      totalCount: null,
      hasNextPage: null,
      endCursor: null,
    });
  }
  for (const missingSource of [
    context.lifecycle.source,
    context.merger.source,
    context.queue.membership.source,
    context.queue.position.source,
  ]) {
    expect(missingSource).toStrictEqual({
      availability: 'unavailable',
      reason: 'not-requested',
      retryable: false,
      provenance: [],
      observedAt: null,
    });
  }
  expect(context).toMatchObject({
    observedAt: null,
    evaluatedShas: [],
    issueCoverage: 'supported-pr-sources',
    lifecycle: { openedAt: null, updatedAt: null, closedAt: null, mergedAt: null },
    merger: { identity: null },
    queue: {
      membership: { state: 'unknown', entryId: null },
      position: { entryId: null, prNodeId: null, value: null, state: null, enqueuedAt: null },
    },
  });
  expect(NormalizedGitHubPrReviewInboxItemSchema.parse(oldInbox)).toStrictEqual({
    ...oldInbox,
    authorDisplayName: null,
  });
});

test('retains full context, source evidence, distinct check identities, and Inbox names', () => {
  const overview = { ...oldOverview, autoMerge: { method: 'squash' }, context: fullContext };
  expect(GitHubPrReviewOverviewSchema.parse(overview)).toStrictEqual(overview);
  expect(NormalizedGitHubPrReviewOverviewSchema.parse(overview)).toStrictEqual(overview);
  expect(
    NormalizedGitHubPrReviewInboxItemSchema.parse({ ...oldInbox, authorDisplayName: 'Octo Cat' })
  ).toStrictEqual({ ...oldInbox, authorDisplayName: 'Octo Cat' });
});

test('normalizes missing source additions without changing a confirmed empty sibling', () => {
  const { context } = NormalizedGitHubPrReviewOverviewSchema.parse({
    ...oldOverview,
    context: { revision, labels: complete([]) },
  });
  expect(context.labels).toStrictEqual(complete([]));
  expect(context.assignees).toMatchObject({
    source: { availability: 'unavailable' },
    completeness: 'unknown',
    totalCount: null,
  });
  expect(context.queue.position).toMatchObject({
    source: { availability: 'unavailable' },
    value: null,
  });
});

test.each([null, undefined])(
  'normalizes an unavailable Inbox name (%s) without inventing an author',
  authorDisplayName => {
    const input = { ...oldInbox, author: null, authorDisplayName };
    expect(GitHubPrReviewInboxItemSchema.parse(input)).toStrictEqual(input);
    expect(NormalizedGitHubPrReviewInboxItemSchema.parse(input)).toStrictEqual({
      ...input,
      authorDisplayName: null,
    });
  }
);

test('normalizes mixed Inbox items without changing names or pagination', () => {
  const named = { ...oldInbox, number: 13, authorDisplayName: 'Octo Cat' };
  const deleted = { ...oldInbox, number: 14, author: null, authorDisplayName: null };
  const page = { items: [oldInbox, named, deleted], nextCursor: 'next-page' };
  expect(GitHubPrReviewInboxResultSchema.parse(page)).toStrictEqual(page);
  expect(NormalizedGitHubPrReviewInboxResultSchema.parse(page)).toStrictEqual({
    items: [{ ...oldInbox, authorDisplayName: null }, named, deleted],
    nextCursor: 'next-page',
  });
});

test('preserves an empty Inbox without inventing an author row', () => {
  const empty = { items: [], nextCursor: null };
  expect(NormalizedGitHubPrReviewInboxResultSchema.parse(empty)).toStrictEqual(empty);
});

test('preserves strict comment-author and legacy aggregate checks contracts', () => {
  const comment = {
    commentId: 1,
    nodeId: 'C_1',
    author,
    bodyMarkdown: 'Review',
    createdAt: observedAt,
    reactions: [],
  };
  const checks = {
    checkRuns: [
      { name: 'ci', status: 'completed', conclusion: 'failure', detailsUrl: null, appName: 'CI' },
    ],
    rollup: { total: 1, success: 0, failure: 1, pending: 0, skipped: 0 },
  };
  expect(GitHubPrReviewReviewCommentSchema.parse(comment)).toStrictEqual(comment);
  expect(GitHubPrReviewChecksResultSchema.parse(checks)).toStrictEqual(checks);
  expect(
    GitHubPrReviewReviewCommentSchema.safeParse({
      ...comment,
      author: { ...author, name: 'Octo Cat' },
    }).success
  ).toBe(false);
  expect(
    GitHubPrReviewChecksResultSchema.safeParse({
      ...checks,
      checkRuns: [{ ...checks.checkRuns[0], requiredness: 'required' }],
    }).success
  ).toBe(false);
});

test.each([undefined, {}])(
  'normalizes missing evaluation sources (%j) without rewriting old evidence',
  evaluationSources => {
    const { evaluationSources: knownSources, ...legacyContext } = fullContext;
    const { context } = NormalizedGitHubPrReviewOverviewSchema.parse({
      ...oldOverview,
      context: { ...legacyContext, evaluationSources },
    });
    const { evaluationSources: normalized, ...preserved } = context;
    expect(preserved).toStrictEqual(legacyContext);
    for (const key of Object.keys(knownSources))
      expect(normalized).toHaveProperty(key, {
        availability: 'unavailable',
        retryable: false,
        reason: 'source-state-not-recorded',
        provenance: [],
        observedAt: null,
      });
  }
);

test.each([
  { availability: 'unavailable', retryable: true, reason: 'transient' },
  { availability: 'denied', retryable: false, reason: 'permission' },
])('retains structured $availability recovery without provenance', failure => {
  const failed = { ...source, ...failure, provenance: [] };
  const input = {
    ...fullContext,
    evaluationSources: { ...fullContext.evaluationSources, comparison: failed },
  };
  expect(
    NormalizedGitHubPrReviewOverviewSchema.parse({ ...oldOverview, context: input }).context
  ).toStrictEqual(input);
  const partial = GitHubPrReviewContextSchema.parse({
    revision,
    evaluationSources: { comparison: failed },
    labels: complete([]),
  });
  expect(partial.evaluationSources.comparison).toStrictEqual(failed);
  expect(partial.evaluationSources.threads).toMatchObject({
    availability: 'unavailable',
    retryable: false,
    reason: 'source-state-not-recorded',
  });
  expect(partial.labels).toStrictEqual(complete([]));
});

test.each([
  ['availability', { availability: 'unknown' }],
  ['retryability', { retryable: 'true' }],
  ['reason', { reason: 403 }],
  ['provenance', { provenance: [''] }],
])('rejects invalid evaluation source %s instead of supplying a fallback', (_name, invalid) => {
  expect(
    GitHubPrReviewContextSchema.safeParse({
      revision,
      evaluationSources: { comparison: { ...source, ...invalid } },
    }).success
  ).toBe(false);
});

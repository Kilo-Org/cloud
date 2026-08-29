import {
  GitHubPrReviewApplicationBindingSchema,
  GitHubPrReviewContextSchema,
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
const fullContext = {
  revision,
  observedAt,
  evaluatedShas: ['head'],
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
    {
      id: 'rule-1',
      kind: 'status-check',
      title: 'CI',
      state: 'unmet',
      policy: { id: 'rule-1', source: 'classic', enforcement: 'active' },
      check: { name: 'ci', kind: 'check-run', application: { kind: 'app', appId: 1 } },
      evidence,
    },
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
  const input = { revision, labels, lifecycle, assignees: complete([]) };
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

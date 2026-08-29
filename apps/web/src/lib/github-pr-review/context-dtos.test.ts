import {
  GitHubPrReviewApplicationBindingSchema,
  GitHubPrReviewContextSchema,
} from './context-dtos';

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

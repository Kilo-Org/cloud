import {
  contextReviewEvidenceConflicts,
  contextReviewSchema,
  resolveContextReviewDecisions,
} from './context-reviews';
import type { GitHubPrReviewContext } from './context-dtos';

const fields = ['latestOpinionatedReviews', 'latestReviews'] as const;
type Field = (typeof fields)[number];
const submittedAt = '2026-08-25T12:00:00+02:00';
const later = '2026-08-26T10:00:00Z';
const person = (id = 'U') => ({
  __typename: 'User',
  id,
  login: 'same-login',
  name: null,
  avatarUrl: null,
  url: null,
});
const connection = (nodes: unknown[], totalCount = nodes.length, next: string | null = null) => ({
  nodes,
  totalCount,
  pageInfo: { hasNextPage: next !== null, endCursor: next },
});
const review = (state = 'APPROVED', id = 'decision', patch: Record<string, unknown> = {}) => ({
  id,
  state,
  author: person(),
  submittedAt,
  commit: { oid: 'reviewed-commit' },
  onBehalfOf: connection([]),
  createdAt: later,
  updatedAt: later,
  ...patch,
});
type Reviews = GitHubPrReviewContext['reviewDecisions'];

// These are normalized source collections, not reader transport fixtures.
const page = (
  field: Field,
  nodes: unknown[],
  availability: Reviews['source']['availability'] = 'available'
): Reviews => {
  const complete = availability === 'available';
  return {
    items: nodes.map(node => contextReviewSchema.parse(node)),
    knownCount: nodes.length,
    totalCount: complete ? nodes.length : null,
    hasNextPage: availability === 'partial' ? true : complete ? false : null,
    endCursor: availability === 'partial' ? `${field}-next` : null,
    completeness: complete ? 'complete' : nodes.length ? 'partial' : 'unknown',
    source: {
      availability,
      retryable: !complete && availability !== 'denied',
      reason: complete ? null : availability,
      provenance: [`graphql.${field}`],
      observedAt: later,
    },
  };
};

async function run(serve: (field: Field) => Reviews, conflictingReviewIds?: ReadonlySet<string>) {
  const opinionated = serve('latestOpinionatedReviews');
  const reviewActivity = serve('latestReviews');
  return {
    reviewDecisions: resolveContextReviewDecisions(
      opinionated,
      reviewActivity,
      conflictingReviewIds
    ),
    reviewActivity,
  };
}

it('does not mistake unavailable evidence for a review conflict', () => {
  const known = contextReviewSchema.parse(review());
  const unavailable = contextReviewSchema.parse(
    review('UNKNOWN', 'decision', { submittedAt: null, commit: null })
  );
  expect(contextReviewEvidenceConflicts(known, unavailable)).toBe(false);
  expect(contextReviewEvidenceConflicts(unavailable, known)).toBe(false);
});

// These synthetic responses exercise the conservative policy, not undocumented provider transitions.
it.each([
  ['APPROVED', 'APPROVED', 'APPROVED'],
  ['APPROVED', 'CHANGES_REQUESTED', 'UNKNOWN'],
  ['APPROVED', 'COMMENTED', 'APPROVED'],
  ['APPROVED', 'DISMISSED', 'UNKNOWN'],
  ['APPROVED', 'PENDING', 'UNKNOWN'],
  ['APPROVED', null, 'UNKNOWN'],
  ['CHANGES_REQUESTED', 'APPROVED', 'UNKNOWN'],
  ['CHANGES_REQUESTED', 'CHANGES_REQUESTED', 'CHANGES_REQUESTED'],
  ['CHANGES_REQUESTED', 'COMMENTED', 'CHANGES_REQUESTED'],
  ['CHANGES_REQUESTED', 'DISMISSED', 'UNKNOWN'],
  ['CHANGES_REQUESTED', 'PENDING', 'UNKNOWN'],
  ['CHANGES_REQUESTED', null, 'UNKNOWN'],
  ['COMMENTED', 'APPROVED', 'UNKNOWN'],
  ['COMMENTED', 'CHANGES_REQUESTED', 'UNKNOWN'],
  ['COMMENTED', 'COMMENTED', null],
  ['COMMENTED', 'DISMISSED', 'UNKNOWN'],
  ['COMMENTED', 'PENDING', 'UNKNOWN'],
  ['COMMENTED', null, 'UNKNOWN'],
  ['DISMISSED', 'APPROVED', 'UNKNOWN'],
  ['DISMISSED', 'CHANGES_REQUESTED', 'UNKNOWN'],
  ['DISMISSED', 'COMMENTED', 'DISMISSED'],
  ['DISMISSED', 'DISMISSED', 'DISMISSED'],
  ['DISMISSED', 'PENDING', 'UNKNOWN'],
  ['DISMISSED', null, 'UNKNOWN'],
  ['PENDING', 'APPROVED', 'UNKNOWN'],
  ['PENDING', 'CHANGES_REQUESTED', 'UNKNOWN'],
  ['PENDING', 'COMMENTED', 'UNKNOWN'],
  ['PENDING', 'DISMISSED', 'UNKNOWN'],
  ['PENDING', 'PENDING', 'UNKNOWN'],
  ['PENDING', null, 'UNKNOWN'],
  ['UNKNOWN', 'APPROVED', 'UNKNOWN'],
  ['UNKNOWN', 'CHANGES_REQUESTED', 'UNKNOWN'],
  ['UNKNOWN', 'COMMENTED', 'UNKNOWN'],
  ['UNKNOWN', 'DISMISSED', 'UNKNOWN'],
  ['UNKNOWN', 'PENDING', 'UNKNOWN'],
  ['UNKNOWN', 'UNKNOWN', 'UNKNOWN'],
  ['UNKNOWN', null, 'UNKNOWN'],
  ['APPROVED', 'UNKNOWN', 'UNKNOWN'],
  ['CHANGES_REQUESTED', 'UNKNOWN', 'UNKNOWN'],
  ['COMMENTED', 'UNKNOWN', 'UNKNOWN'],
  ['DISMISSED', 'UNKNOWN', 'UNKNOWN'],
  ['PENDING', 'UNKNOWN', 'UNKNOWN'],
  [null, 'UNKNOWN', 'UNKNOWN'],
  [null, 'APPROVED', 'APPROVED'],
  [null, 'CHANGES_REQUESTED', 'CHANGES_REQUESTED'],
  [null, 'COMMENTED', null],
  [null, 'DISMISSED', 'DISMISSED'],
  [null, 'PENDING', 'UNKNOWN'],
  [null, null, null],
])('resolves opinionated %s beside latest %s as %s', async (opinionated, activity, expected) => {
  const latestId = opinionated === activity ? 'decision' : 'activity';
  const latestTime = opinionated === activity ? submittedAt : later;
  const result = await run(field =>
    page(
      field,
      field === 'latestOpinionatedReviews'
        ? opinionated
          ? [review(opinionated)]
          : []
        : activity
          ? [review(activity, latestId, { submittedAt: latestTime })]
          : []
    )
  );
  expect(
    result.reviewDecisions.items.map(({ id, state, submittedAt: time }) => ({ id, state, time }))
  ).toEqual(
    expected
      ? [
          {
            id: opinionated ? 'decision' : latestId,
            state: expected,
            time:
              (opinionated ?? activity) === 'PENDING'
                ? null
                : opinionated
                  ? submittedAt
                  : latestTime,
          },
        ]
      : []
  );
  expect(result.reviewDecisions.source).toMatchObject({
    availability: expected === 'UNKNOWN' ? 'partial' : 'available',
    retryable: expected === 'UNKNOWN',
  });
  expect(result.reviewActivity.items).toMatchObject(
    activity
      ? [{ id: latestId, state: activity, submittedAt: activity === 'PENDING' ? null : latestTime }]
      : []
  );
});

it.each([
  ['state', { state: 'CHANGES_REQUESTED' }],
  ['commit', { commit: { oid: 'contradictory-commit' } }],
  ['submission', { submittedAt: later }],
  ['review ID', { id: 'other-approval' }],
  ['actor ID', { author: person('other') }],
  ['actor type', { author: { ...person(), __typename: 'Bot' } }],
  ['missing actor', { author: null }],
  ['unknown state', { state: 'FUTURE_STATE' }],
  ['older comment', { id: 'comment', state: 'COMMENTED', submittedAt: '2020-01-01T00:00:00Z' }],
])('does not assert a decision after contradictory %s responses', async (_name, patch) => {
  const result = await run(field =>
    page(field, [review('APPROVED', 'decision', field === 'latestReviews' ? patch : {})])
  );
  expect(result.reviewDecisions.items.length).toBeGreaterThan(0);
  expect(result.reviewDecisions.items.every(item => item.state === 'UNKNOWN')).toBe(true);
  expect(result.reviewDecisions.source).toMatchObject({
    availability: 'partial',
    reason: 'review-inconsistent',
    retryable: true,
  });
});

it.each(fields)('does not rank two decisions for one actor in %s by time', async duplicate => {
  const result = await run(field =>
    page(
      field,
      field === duplicate
        ? [review(), review('CHANGES_REQUESTED', 'other', { submittedAt: later })]
        : [review()]
    )
  );
  expect(result.reviewDecisions.items).toMatchObject([{ state: 'UNKNOWN' }]);
  expect(result.reviewDecisions.source.reason).toBe('review-inconsistent');
});

it('keeps actor IDs, types, and deleted review identities distinct despite identical logins', async () => {
  const reviews = [
    ...['User', 'Bot', 'Mannequin'].map((kind, i) =>
      review('APPROVED', `typed-${i}`, { author: { ...person(`U${i}`), __typename: kind } })
    ),
    review('APPROVED', 'deleted-1', { author: null }),
    review('CHANGES_REQUESTED', 'deleted-2', { author: null }),
  ];
  const result = await run(field => page(field, reviews));
  expect(result.reviewDecisions.items).toMatchObject([
    { id: 'typed-0', actor: { id: 'U0', kind: 'User', login: 'same-login' } },
    { id: 'typed-1', actor: { id: 'U1', kind: 'Bot' } },
    { id: 'typed-2', actor: { id: 'U2', kind: 'Mannequin' } },
    { id: 'deleted-1', actor: null, state: 'APPROVED' },
    { id: 'deleted-2', actor: null, state: 'CHANGES_REQUESTED' },
  ]);
  expect(result.reviewDecisions.knownCount).toBe(5);
});

it.each(fields)('retains a consistent decision when %s is partial', async partial => {
  const result = await run(field =>
    page(field, [review()], field === partial ? 'partial' : 'available')
  );
  expect(result.reviewDecisions).toMatchObject({
    items: [{ id: 'decision', state: 'APPROVED', submittedAt }],
    completeness: 'partial',
    totalCount: null,
    hasNextPage: true,
    endCursor: null,
    source: {
      availability: 'partial',
      retryable: true,
      provenance: ['graphql.latestOpinionatedReviews', 'graphql.latestReviews'],
    },
  });
});

it.each(
  fields.flatMap(field =>
    (['partial', 'denied', 'unavailable'] as const).map(
      availability => [field, availability] as const
    )
  )
)('does not infer absence from %s being %s', async (missing, availability) => {
  const result = await run(field =>
    page(field, field === missing ? [] : [review()], field === missing ? availability : 'available')
  );
  expect(result.reviewDecisions).toMatchObject({
    items: [{ state: 'UNKNOWN', submittedAt }],
    completeness: 'partial',
    totalCount: null,
    source: { availability: 'partial', reason: availability, retryable: availability !== 'denied' },
  });
});

describe.each(fields)('%s state errors', failedField => {
  it.each([
    { error: 'FORBIDDEN', reason: 'graphql-denied', retryable: false },
    { error: 'INTERNAL', reason: 'graphql-incomplete', retryable: true },
  ])('preserves source metadata after $error', async ({ reason, retryable }) => {
    const result = await run(field => {
      const failed = field === failedField;
      const reviews = page(field, [
        review(failed ? 'UNKNOWN' : 'APPROVED'),
        review('APPROVED', 'unaffected', { author: person('other') }),
      ]);
      if (failed) {
        reviews.completeness = 'partial';
        reviews.source = { ...reviews.source, availability: 'partial', reason, retryable };
      }
      return reviews;
    });
    expect(result.reviewDecisions).toMatchObject({
      items: [
        { id: 'decision', state: 'UNKNOWN', submittedAt, commitSha: 'reviewed-commit' },
        { id: 'unaffected', state: 'APPROVED' },
      ],
      knownCount: 2,
      totalCount: null,
      hasNextPage: null,
      endCursor: null,
      completeness: 'partial',
      source: {
        availability: 'partial',
        reason,
        retryable,
        provenance: ['graphql.latestOpinionatedReviews', 'graphql.latestReviews'],
        observedAt: later,
      },
    });
    expect(result.reviewActivity.items).toMatchObject([
      { id: 'decision', state: failedField === 'latestReviews' ? 'UNKNOWN' : 'APPROVED' },
      { id: 'unaffected', state: 'APPROVED' },
    ]);
  });

  it.each([
    ['commit', { commit: { oid: 'contradictory-commit' } }],
    ['submission', { submittedAt: later }],
    ['actor ID', { author: person('other') }],
  ])('retains contradictory %s evidence beside a denied state', async (_name, patch) => {
    const result = await run(field => {
      const failed = field === failedField;
      const reviews = page(field, [
        review(failed ? 'UNKNOWN' : 'APPROVED', 'decision', failed ? patch : {}),
      ]);
      if (failed) {
        reviews.completeness = 'partial';
        reviews.source = {
          ...reviews.source,
          availability: 'partial',
          reason: 'graphql-denied',
          retryable: false,
        };
      }
      return reviews;
    });
    expect(result.reviewDecisions.items.length).toBeGreaterThan(0);
    expect(result.reviewDecisions.items.every(item => item.state === 'UNKNOWN')).toBe(true);
    expect(result.reviewDecisions).toMatchObject({
      totalCount: null,
      completeness: 'partial',
      source: { availability: 'partial', reason: 'review-inconsistent', retryable: true },
    });
  });
});

describe.each(fields)('%s sibling state errors', failedField => {
  it.each([
    { error: 'FORBIDDEN', reason: 'graphql-denied', retryable: false },
    { error: 'INTERNAL', reason: 'graphql-incomplete', retryable: true },
  ])('retains explicit conflict metadata beside $error', async ({ reason, retryable }) => {
    const result = await run(
      field => {
        const failed = field === failedField;
        const reviews = page(field, [
          review(field === 'latestOpinionatedReviews' ? 'UNKNOWN' : 'APPROVED', 'decision', {
            submittedAt: field === 'latestOpinionatedReviews' ? null : submittedAt,
            commit: field === 'latestOpinionatedReviews' ? null : { oid: 'reviewed-commit' },
          }),
          review(failed ? 'UNKNOWN' : 'APPROVED', 'failed', { author: person('failed') }),
          review('APPROVED', 'unaffected', { author: person('unaffected') }),
        ]);
        if (failed) {
          reviews.completeness = 'partial';
          reviews.source = { ...reviews.source, availability: 'partial', reason, retryable };
        }
        return reviews;
      },
      new Set(['decision'])
    );
    expect(result.reviewDecisions).toMatchObject({
      items: [
        { id: 'decision', state: 'UNKNOWN', submittedAt: null, commitSha: null },
        { id: 'failed', state: 'UNKNOWN' },
        { id: 'unaffected', state: 'APPROVED', submittedAt, commitSha: 'reviewed-commit' },
      ],
      knownCount: 3,
      totalCount: null,
      hasNextPage: null,
      endCursor: null,
      completeness: 'partial',
      source: {
        availability: 'partial',
        reason: 'review-inconsistent',
        retryable: true,
        provenance: ['graphql.latestOpinionatedReviews', 'graphql.latestReviews'],
        observedAt: later,
      },
    });
    expect(result.reviewActivity.items).toMatchObject([
      { id: 'decision', state: 'APPROVED', submittedAt, commitSha: 'reviewed-commit' },
      { id: 'failed', state: failedField === 'latestReviews' ? 'UNKNOWN' : 'APPROVED' },
      { id: 'unaffected', state: 'APPROVED' },
    ]);
  });
});

it('rejects matching final observations for an explicitly conflicted review', async () => {
  const result = await run(
    field => page(field, [review(), review('APPROVED', 'stable', { author: person('stable') })]),
    new Set(['decision'])
  );
  expect(result.reviewDecisions).toMatchObject({
    items: [
      { id: 'decision', state: 'UNKNOWN' },
      { id: 'stable', state: 'APPROVED' },
    ],
    totalCount: null,
    completeness: 'partial',
    source: { availability: 'partial', reason: 'review-inconsistent', retryable: true },
  });
});

it.each(['available', 'denied', 'unavailable'] as const)(
  'distinguishes %s sources without reviews from complete empty evidence',
  async availability => {
    const result = await run(field => page(field, [], availability));
    expect(result.reviewDecisions).toMatchObject({
      items: [],
      knownCount: 0,
      totalCount: availability === 'available' ? 0 : null,
      completeness: availability === 'available' ? 'complete' : 'unknown',
      source: { availability, retryable: availability === 'unavailable' },
    });
  }
);

it.each([null, undefined, 'invalid'])(
  'never borrows a clock for selected submission %p',
  async time => {
    for (const state of ['APPROVED', 'COMMENTED']) {
      const result = await run(field =>
        page(field, [
          field === 'latestOpinionatedReviews'
            ? review('APPROVED', 'decision', { submittedAt: time })
            : review(state, state === 'APPROVED' ? 'decision' : 'comment', { submittedAt: later }),
        ])
      );
      expect(result.reviewDecisions.items).toMatchObject([
        { id: 'decision', state: 'APPROVED', submittedAt: null },
      ]);
      expect(result.reviewActivity.items).toMatchObject([{ state, submittedAt: later }]);
    }
  }
);

it('compares equal instants without replacing the selected submission representation', async () => {
  const result = await run(field =>
    page(field, [
      review('APPROVED', 'decision', {
        submittedAt: field === 'latestReviews' ? '2026-08-25T10:00:00Z' : submittedAt,
      }),
    ])
  );
  expect(result.reviewDecisions.items).toMatchObject([{ state: 'APPROVED', submittedAt }]);
});

it('rejects conflicting review identities across reviewer groups without erasing a sibling', async () => {
  const result = await run(field =>
    page(field, [
      ...(field === 'latestOpinionatedReviews'
        ? [review(), review('CHANGES_REQUESTED', 'other', { author: person('other') })]
        : [
            review('COMMENTED', 'comment', { submittedAt: later }),
            review('COMMENTED', 'decision', { author: person('other'), submittedAt: later }),
          ]),
      review('APPROVED', 'stable', { author: person('stable') }),
    ])
  );
  expect(result.reviewDecisions.items).toMatchObject([
    { id: 'decision', state: 'UNKNOWN' },
    { id: 'other', state: 'UNKNOWN' },
    { id: 'stable', state: 'APPROVED' },
  ]);
  expect(result.reviewDecisions.source).toMatchObject({
    availability: 'partial',
    reason: 'review-inconsistent',
    retryable: true,
  });
});

it.each([false, true])(
  'keeps explicit team attribution %p separate from a decision',
  async attributed => {
    const team = {
      __typename: 'Team',
      id: 'T',
      teamName: 'Requested team',
      slug: 'team',
      teamAvatarUrl: null,
      url: null,
    };
    const result = await run(field =>
      page(field, [
        field === 'latestOpinionatedReviews'
          ? review('APPROVED', 'decision', { onBehalfOf: connection(attributed ? [team] : []) })
          : review('COMMENTED', 'comment', { submittedAt: later, onBehalfOf: connection([team]) }),
      ])
    );
    expect(result.reviewDecisions.items).toMatchObject([
      {
        id: 'decision',
        actor: { id: 'U', kind: 'User' },
        state: 'APPROVED',
        onBehalfOf: { items: attributed ? [{ id: 'T', kind: 'Team', teamSlug: 'team' }] : [] },
      },
    ]);
    expect(result.reviewDecisions.items).toHaveLength(1);
    expect(result.reviewActivity.items[0]?.onBehalfOf.items).toMatchObject([
      { id: 'T', kind: 'Team' },
    ]);
  }
);

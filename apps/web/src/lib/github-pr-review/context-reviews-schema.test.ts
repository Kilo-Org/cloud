import { contextReviewSchema } from './context-reviews';

const submittedAt = '2026-08-25T12:00:00+02:00';
const later = '2026-08-26T10:00:00Z';
const actor = {
  __typename: 'User',
  id: 'U',
  login: 'same-login',
  name: ' Person ',
  avatarUrl: 'https://github.com/avatar.png',
  url: 'https://github.com/person',
};
const team = {
  __typename: 'Team',
  id: 'T',
  teamName: 'Review team',
  slug: 'team',
  teamAvatarUrl: null,
  url: null,
};
const connection = (nodes: unknown[], totalCount = nodes.length, next: string | null = null) => ({
  nodes,
  totalCount,
  pageInfo: { hasNextPage: next !== null, endCursor: next },
});
const review = (patch: Record<string, unknown> = {}) => ({
  id: 'decision',
  state: 'APPROVED',
  author: actor,
  submittedAt,
  commit: { oid: 'reviewed-commit' },
  onBehalfOf: connection([]),
  createdAt: later,
  updatedAt: later,
  ...patch,
});

it.each(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'])(
  'preserves the submitted %s review and its own clock',
  state => {
    expect(contextReviewSchema.parse(review({ state }))).toMatchObject({
      id: 'decision',
      state,
      submittedAt: '2026-08-25T12:00:00+02:00',
      commitSha: 'reviewed-commit',
      actor: { id: 'U', kind: 'User' },
    });
  }
);

it.each([null, undefined, 'invalid'])(
  'does not substitute another clock for submission time %p',
  time => {
    const result = contextReviewSchema.parse(review({ submittedAt: time }));
    expect(result.submittedAt).toBeNull();
    expect(result).not.toHaveProperty('createdAt');
    expect(result).not.toHaveProperty('updatedAt');
  }
);

it('keeps a pending review unsubmitted even when the response contains a time', () => {
  expect(contextReviewSchema.parse(review({ state: 'PENDING' }))).toMatchObject({
    id: 'decision',
    state: 'PENDING',
    submittedAt: null,
  });
});

it.each(['FUTURE_STATE', null, undefined])('keeps unsupported state %p unknown', state => {
  expect(contextReviewSchema.parse(review({ state }))).toMatchObject({
    id: 'decision',
    state: 'UNKNOWN',
    submittedAt: '2026-08-25T12:00:00+02:00',
  });
});

it.each([
  ['User', 'Person'],
  ['Bot', null],
  ['Mannequin', null],
])('normalizes the %s actor without using its login as an ID', (kind, name) => {
  expect(
    contextReviewSchema.parse(review({ author: { ...actor, __typename: kind } })).actor
  ).toEqual({
    id: 'U',
    kind,
    login: 'same-login',
    name,
    avatarUrl: 'https://github.com/avatar.png',
    url: 'https://github.com/person',
    teamSlug: null,
  });
});

it.each([null, undefined, {}, team])(
  'retains a review with unavailable individual actor %p',
  author => {
    expect(contextReviewSchema.parse(review({ author }))).toMatchObject({
      id: 'decision',
      actor: null,
      state: 'APPROVED',
    });
  }
);

it.each([null, undefined, {}, { oid: '' }])('keeps unavailable commit %p null', commit => {
  expect(contextReviewSchema.parse(review({ commit }))).toMatchObject({
    id: 'decision',
    commitSha: null,
    submittedAt: '2026-08-25T12:00:00+02:00',
  });
});

it.each([null, undefined, ''])('rejects missing review identity %p', id => {
  expect(() => contextReviewSchema.parse(review({ id }))).toThrow();
});

it('keeps complete empty attribution distinct from missing attribution', () => {
  expect(contextReviewSchema.parse(review()).onBehalfOf).toMatchObject({
    items: [],
    knownCount: 0,
    totalCount: 0,
    completeness: 'complete',
    hasNextPage: false,
    endCursor: null,
    source: { availability: 'available', retryable: false, reason: null },
  });
});

it.each([null, undefined, {}])('keeps unavailable attribution %p unknown', onBehalfOf => {
  expect(contextReviewSchema.parse(review({ onBehalfOf })).onBehalfOf).toMatchObject({
    items: [],
    knownCount: 0,
    totalCount: null,
    completeness: 'unknown',
    hasNextPage: null,
    endCursor: null,
    source: { availability: 'unavailable', retryable: true, reason: 'attribution-incomplete' },
  });
});

it('keeps complete team attribution separate from the individual review', () => {
  const result = contextReviewSchema.parse(review({ onBehalfOf: connection([team]) }));
  expect(result).toMatchObject({
    id: 'decision',
    actor: { id: 'U', kind: 'User' },
    state: 'APPROVED',
  });
  expect(result.onBehalfOf).toMatchObject({
    items: [{ id: 'T', kind: 'Team', name: 'Review team', teamSlug: 'team', login: null }],
    knownCount: 1,
    totalCount: 1,
    completeness: 'complete',
    source: { availability: 'available', retryable: false },
  });
});

it('retains a team page without claiming complete attribution', () => {
  const result = contextReviewSchema.parse(
    review({ onBehalfOf: connection([team], 101, 'team-next') })
  );
  expect(result.onBehalfOf).toMatchObject({
    items: [{ id: 'T', kind: 'Team' }],
    knownCount: 1,
    totalCount: 101,
    completeness: 'partial',
    hasNextPage: true,
    endCursor: 'team-next',
    source: { availability: 'partial', retryable: true, reason: 'attribution-incomplete' },
  });
});

it.each([
  { name: 'duplicate', nodes: [team, team] },
  { name: 'invalid', nodes: [team, null, {}, actor] },
])('retains known teams without claiming complete $name attribution', ({ nodes }) => {
  const result = contextReviewSchema.parse(review({ onBehalfOf: connection(nodes) }));
  expect(result.onBehalfOf).toMatchObject({
    items: [{ id: 'T', kind: 'Team' }],
    knownCount: 1,
    completeness: 'partial',
    source: { availability: 'partial', retryable: true },
  });
  expect(result.onBehalfOf.items).toHaveLength(1);
});

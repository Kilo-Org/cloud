import { contextIssueEventSchema, contextIssueSchema } from './context-issues';

const createdAt = '2026-08-28T12:00:00+02:00';
const pr = { __typename: 'PullRequest', id: 'PR_current' };
const issue = {
  __typename: 'Issue',
  id: 'I_first',
  number: 7,
  title: `  ${'Full issue title with details beyond a narrow screen. '.repeat(6)}  `,
  state: 'OPEN',
  repository: { nameWithOwner: 'owner/repo' },
  url: 'https://github.com/owner/repo/issues/7',
};

it('preserves full issue data and same-number identities across repositories', () => {
  const otherIssue = {
    ...issue,
    id: 'I_other',
    state: 'CLOSED',
    repository: { nameWithOwner: 'other/repo' },
    url: 'https://github.com/other/repo/issues/7',
  };
  expect([issue, otherIssue].map(value => contextIssueSchema.parse(value))).toEqual([
    issue,
    otherIssue,
  ]);
});

it.each([null, undefined, 'not a URL'])('retains issue identity when its URL is %p', url => {
  expect(contextIssueSchema.parse({ ...issue, url })).toEqual({ ...issue, url: null });
});

it.each([
  { __typename: 'PullRequest' },
  { id: '' },
  { id: null },
  { id: undefined },
  { number: 0 },
  { number: -1 },
  { number: 1.5 },
  { number: '7' },
  { number: undefined },
  { title: null },
  { title: undefined },
  { state: 'MERGED' },
  { state: undefined },
  { repository: null },
  { repository: {} },
  { repository: { nameWithOwner: '' } },
  { repository: { nameWithOwner: 7 } },
])('rejects malformed issue fields %p', patch => {
  expect(contextIssueSchema.safeParse({ ...issue, ...patch }).success).toBe(false);
});

it.each([null, undefined, {}, pr])('rejects a missing or non-issue node %p', node => {
  expect(contextIssueSchema.safeParse(node).success).toBe(false);
});

describe.each([
  ['ConnectedEvent', 'source', 'subject', 'connected', false],
  ['DisconnectedEvent', 'source', 'subject', 'connected', true],
  ['CrossReferencedEvent', 'source', 'target', 'referenced', false],
  ['MarkedAsDuplicateEvent', 'duplicate', 'canonical', 'duplicate', false],
  ['UnmarkedAsDuplicateEvent', 'duplicate', 'canonical', 'duplicate', true],
] as const)('%s', (type, sourceField, targetField, category, removed) => {
  const event = (source: unknown, target: unknown, patch: Record<string, unknown> = {}) => ({
    __typename: type,
    id: 'event-id',
    createdAt,
    [sourceField]: source,
    [targetField]: target,
    ...(type === 'CrossReferencedEvent'
      ? { referencedAt: '2026-08-29T09:00:00Z', willCloseTarget: true }
      : {}),
    ...patch,
  });

  it.each([
    ['PR to issue', pr, issue],
    ['issue to PR', issue, pr],
    ['deleted source', null, issue],
    ['deleted target', issue, null],
    ['deleted endpoints', null, null],
  ])('preserves %s with its category and removal marker', (_direction, source, target) => {
    expect(contextIssueEventSchema.parse(event(source, target))).toEqual({
      id: 'event-id',
      createdAt,
      category,
      removed,
      source,
      target,
    });
  });

  it.each([null, undefined, 'invalid', '2026-08-28T12:00:00'])(
    'retains evidence with unavailable creation time %p without borrowing another clock',
    time => {
      expect(contextIssueEventSchema.parse(event(pr, issue, { createdAt: time }))).toEqual({
        id: 'event-id',
        createdAt: null,
        category,
        removed,
        source: pr,
        target: issue,
      });
    }
  );

  it.each([
    undefined,
    {},
    { __typename: 'User', id: 'U' },
    { ...pr, id: '' },
    { ...issue, id: '' },
    { ...issue, number: 0 },
  ])('rejects malformed endpoint %p in either position', endpoint => {
    expect(() => contextIssueEventSchema.parse(event(endpoint, issue))).toThrow();
    expect(() => contextIssueEventSchema.parse(event(pr, endpoint))).toThrow();
  });

  it.each([null, undefined, 'not a URL'])('retains an issue endpoint with URL %p', url => {
    const endpoint = { ...issue, url };
    expect(contextIssueEventSchema.parse(event(pr, endpoint)).target).toEqual({
      ...issue,
      url: null,
    });
    expect(contextIssueEventSchema.parse(event(endpoint, pr)).source).toEqual({
      ...issue,
      url: null,
    });
  });

  it.each(['', null, undefined])('rejects unavailable event identity %p', id => {
    expect(() => contextIssueEventSchema.parse(event(pr, issue, { id }))).toThrow();
  });
});

it.each([
  null,
  undefined,
  {},
  { __typename: 'LabeledEvent', id: 'event-id', createdAt, source: pr, target: issue },
])('rejects missing or unsupported event %p', event => {
  expect(contextIssueEventSchema.safeParse(event).success).toBe(false);
});

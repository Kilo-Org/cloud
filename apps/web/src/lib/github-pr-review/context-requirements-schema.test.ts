import {
  contextCheckSchema,
  contextComparisonSchema,
  contextDeploymentSchema,
  contextTestMergeSchema,
  contextThreadSchema,
} from './context-requirements';

const app = { databaseId: 41, id: 'APP', slug: 'ci', name: 'Shared CI' };
const run = {
  __typename: 'CheckRun',
  id: 'RUN',
  name: 'ci',
  checkSuite: { app, commit: { oid: 'head' } },
};
const status = {
  __typename: 'StatusContext',
  id: 'STATUS',
  context: 'ci',
  commit: { oid: 'merge' },
};

it('keeps same-name run/status identities and application IDs separate', () => {
  const otherApp = { ...app, databaseId: 52, id: 'OTHER_APP' };
  const other = { ...run, id: 'OTHER_RUN', checkSuite: { ...run.checkSuite, app: otherApp } };
  const checks = [run, status, other].map(node => contextCheckSchema.parse(node));
  expect(checks.map(({ id, name, kind, evaluatedSha }) => [id, name, kind, evaluatedSha])).toEqual([
    ['RUN', 'ci', 'check-run', 'head'],
    ['STATUS', 'ci', 'status', 'merge'],
    ['OTHER_RUN', 'ci', 'check-run', 'head'],
  ]);
  expect(checks.map(check => check.application)).toEqual([
    { id: 41, nodeId: 'APP', slug: 'ci', name: 'Shared CI' },
    null,
    { id: 52, nodeId: 'OTHER_APP', slug: 'ci', name: 'Shared CI' },
  ]);
});

describe.each([run, status])('$__typename fields', node => {
  it.each([
    [true, 'required'],
    [false, 'optional'],
    [null, 'unknown'],
    [undefined, 'unknown'],
    ['false', 'unknown'],
    [0, 'unknown'],
  ])('maps isRequired %p to %s independently of failure', (isRequired, requiredness) => {
    const check = contextCheckSchema.parse({
      ...node,
      isRequired,
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      state: 'FAILURE',
    });
    expect([check.requiredness, check.outcome]).toEqual([requiredness, 'failure']);
  });
  it.each([null, undefined, 7])('keeps unavailable optional fields %p null', value => {
    const check = contextCheckSchema.parse({
      ...node,
      checkSuite: value,
      commit: value,
      detailsUrl: value,
      targetUrl: value,
    });
    expect([
      check.id,
      check.application,
      check.evaluatedSha,
      check.detailsUrl,
      check.outcome,
    ]).toEqual([node.id, null, null, null, 'unknown']);
  });
  it.each([null, undefined, '', 7])('rejects malformed source identity %p', value => {
    expect(contextCheckSchema.safeParse({ ...node, id: value }).success).toBe(false);
    expect(contextCheckSchema.safeParse({ ...node, name: value, context: value }).success).toBe(
      false
    );
  });
});

it.each([null, undefined, 0, -1, 1.5, '41'])(
  'does not infer application ID from %p',
  databaseId => {
    const check = contextCheckSchema.parse({
      ...run,
      checkSuite: { ...run.checkSuite, app: { ...app, databaseId } },
    });
    expect(check.application).toEqual({ id: null, nodeId: 'APP', slug: 'ci', name: 'Shared CI' });
  }
);

it.each([
  ['run', 'COMPLETED', 'SUCCESS', 'success'],
  ['run', 'COMPLETED', 'NEUTRAL', 'skipped'],
  ['run', 'COMPLETED', 'SKIPPED', 'skipped'],
  ['run', 'COMPLETED', 'FAILURE', 'failure'],
  ['run', 'COMPLETED', null, 'unknown'],
  ['run', 'IN_PROGRESS', 'FAILURE', 'pending'],
  ['run', 'FUTURE_STATUS', 'SUCCESS', 'unknown'],
  ['status', 'SUCCESS', null, 'success'],
  ['status', 'FAILURE', null, 'failure'],
  ['status', 'ERROR', null, 'failure'],
  ['status', 'PENDING', null, 'pending'],
  ['status', 'EXPECTED', null, 'pending'],
  ['status', 'FUTURE_STATE', null, 'unknown'],
])('maps %s %p/%p to %s', (kind, state, conclusion, outcome) => {
  const check = contextCheckSchema.parse({
    ...(kind === 'run' ? run : status),
    status: state,
    state,
    conclusion,
  });
  expect(check.outcome).toBe(outcome);
});

it.each([
  [
    'test-merge',
    contextTestMergeSchema,
    {
      oid: 'merge',
      parents: { totalCount: 2, nodes: [{ oid: 'base' }, { oid: 'head' }] },
    },
  ],
  [
    'comparison',
    contextComparisonSchema,
    {
      behindBy: 0,
      baseTarget: { oid: 'base' },
      headTarget: { oid: 'head' },
    },
  ],
  ['thread', contextThreadSchema, { id: 'THREAD', isResolved: false }],
  [
    'deployment',
    contextDeploymentSchema,
    {
      id: 'DEPLOYMENT',
      commitOid: 'merge',
      environment: 'production',
      latestStatus: { state: 'FAILURE' },
    },
  ],
] as const)('preserves %s identity and rejects missing fields', (_kind, schema, input) => {
  expect(schema.parse(input)).toEqual(input);
  expect(schema.safeParse({}).success).toBe(false);
});

it('retains unavailable fact fields without inventing their values', () => {
  expect(contextTestMergeSchema.parse(null)).toBeNull();
  expect(contextComparisonSchema.parse(null)).toBeNull();
  expect(
    contextTestMergeSchema.parse({ oid: 'merge', parents: { totalCount: 1, nodes: [] } })
  ).toEqual({ oid: 'merge', parents: null });
  expect(contextThreadSchema.parse({ id: 'THREAD', isResolved: 'false' })).toEqual({
    id: 'THREAD',
    isResolved: null,
  });
  const deployment = {
    id: 'DEPLOYMENT',
    commitOid: 'merge',
    environment: null,
    latestStatus: null,
  };
  expect(contextDeploymentSchema.parse(deployment)).toEqual(deployment);
});

it.each([-1, 0.5])('rejects invalid comparison lag %p', behindBy => {
  expect(
    contextComparisonSchema.safeParse({
      behindBy,
      baseTarget: { oid: 'base' },
      headTarget: { oid: 'head' },
    }).success
  ).toBe(false);
});

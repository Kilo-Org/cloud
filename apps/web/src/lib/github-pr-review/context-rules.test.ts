import type { RestEndpointMethodTypes } from '@octokit/rest';
import { type GitHubPrReviewSource, GitHubPrReviewContextSchema } from './context-dtos';
import { normalizeContextPolicies } from './context-rules';

type Repos = RestEndpointMethodTypes['repos'];
const base = { baseRepoFullName: 'kilo/upstream', baseRef: 'release/1', baseSha: 'base' };
const revision = { ...base, prNodeId: 'PR_1', number: 1, headSha: 'head' };
const observedAt = '2026-08-29T12:00:00Z';
const collection = (items: unknown[], provenance: string) => ({
  items,
  knownCount: items.length,
  totalCount: items.length,
  completeness: 'complete' as const,
  hasNextPage: false,
  endCursor: null,
  source: {
    availability: 'available' as const,
    retryable: false,
    reason: null,
    observedAt,
    provenance: [provenance],
  },
});
const classic = (items: unknown[] = []) => collection(items, 'rest.branchProtection');
const rules = (items: unknown[] = []) => collection(items, 'rest.branchRules');
const origin = {
  ruleset_id: 12,
  ruleset_source: 'kilo',
  ruleset_source_type: 'Organization',
} as const;
const signature = {
  type: 'required_signatures',
  ...origin,
} satisfies Repos['getBranchRules']['response']['data'][number];
const protection = {
  enforce_admins: { enabled: true, url: 'https://api.github.com/admins' },
  required_status_checks: {
    strict: true,
    contexts: ['ci', 'legacy'],
    checks: [
      { context: 'ci', app_id: 7 },
      { context: 'ci', app_id: 8 },
    ],
  },
  required_pull_request_reviews: {
    required_approving_review_count: 2,
    dismiss_stale_reviews: true,
    require_code_owner_reviews: true,
    require_last_push_approval: true,
    bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
  },
  required_conversation_resolution: { enabled: true },
  required_signatures: { enabled: true, url: 'https://api.github.com/signatures' },
  required_linear_history: { enabled: true },
  allow_force_pushes: { enabled: false },
  lock_branch: { enabled: false },
} satisfies Repos['getBranchProtection']['response']['data'];
const inherited = [
  {
    type: 'pull_request',
    parameters: {
      required_approving_review_count: 3,
      dismiss_stale_reviews_on_push: true,
      require_code_owner_review: true,
      require_last_push_approval: true,
      required_review_thread_resolution: true,
    },
  },
  {
    type: 'required_deployments',
    parameters: { required_deployment_environments: ['production'] },
  },
  {
    type: 'workflows',
    parameters: {
      workflows: [
        { repository_id: 42, path: '.github/workflows/ci.yml', ref: 'release', sha: 'workflow' },
      ],
    },
  },
  {
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
      required_status_checks: [{ context: 'ci', integration_id: 7 }],
    },
  },
  signature,
] satisfies Repos['getBranchRules']['response']['data'];
function normalize(classicItems: unknown[], branchItems: unknown[]) {
  return normalizeContextPolicies(revision, classic(classicItems), rules(branchItems));
}

test.each([false, true])('retains classic parameters without inferring bypass (%s)', enabled => {
  const configuration = {
    ...protection,
    enforce_admins: { ...protection.enforce_admins, enabled },
  };
  const result = normalize([configuration], []);
  expect(result.completeness).toBe('complete');
  expect(result.items[0]?.policy).toMatchObject({
    parameters: configuration,
    base,
    viewerBypass: 'unknown',
    viewerEnforcement: 'unknown',
    bypassActors: null,
  });
  expect(result.items.flatMap(item => (item.check ? [item.check] : []))).toEqual([
    { name: 'ci', kind: 'unknown', application: { kind: 'app', appId: 7 } },
    { name: 'ci', kind: 'unknown', application: { kind: 'app', appId: 8 } },
    { name: 'legacy', kind: 'unknown', application: { kind: 'unknown' } },
  ]);
  expect(new Set(result.items.map(item => item.id)).size).toBe(4);
  expect(
    GitHubPrReviewContextSchema.parse({ revision, requirements: result }).requirements
  ).toEqual(result);
});

test.each(inherited)('retains inherited $type without evaluating it', rule => {
  const result = normalize([], [{ ...rule, ...origin }]);
  expect(result.completeness).toBe('complete');
  expect(result.items[0]?.policy).toMatchObject({
    base,
    ruleType: rule.type,
    enforcement: 'active',
    viewerEnforcement: 'unknown',
    viewerBypass: 'unknown',
    bypassActors: null,
    parameters: 'parameters' in rule ? rule.parameters : null,
    ruleset: { id: 12, source: 'kilo', sourceType: 'Organization' },
  });
  for (const item of result.items) {
    expect(item.state).toBe('unavailable');
    expect(item.evidence[0]).toMatchObject({
      source: 'rest.branchRules',
      headSha: 'head',
      baseSha: 'base',
      evaluatedSha: null,
      observedAt,
    });
  }
});

const unknownBinding = { kind: 'unknown' };
test.each([
  [7, { kind: 'app', appId: 7 }, { kind: 'app', appId: 7 }] as const,
  [-1, { kind: 'any' }, unknownBinding] as const,
  ...[null, undefined, 0, -2, 7.5, Number.MAX_SAFE_INTEGER + 1].map(
    id => [id, unknownBinding, unknownBinding] as const
  ),
])('normalizes binding %s without inventing a wildcard', (id, classicBinding, rulesetBinding) => {
  const classicCheck = { context: 'ci', ...(id === undefined ? {} : { app_id: id }) };
  const rulesetCheck = { context: 'ci', ...(id === undefined ? {} : { integration_id: id }) };
  const result = normalize(
    [{ required_status_checks: { strict: true, contexts: ['ci'], checks: [classicCheck] } }],
    [
      {
        ...origin,
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [rulesetCheck],
        },
      },
    ]
  );
  expect(result.items.flatMap(item => (item.check ? [item.check.application] : []))).toEqual([
    classicBinding,
    rulesetBinding,
  ]);
});

test.each(['active', 'evaluate', 'disabled'] as const)(
  'does not treat an unfiltered %s ruleset as applicable branch rules',
  enforcement => {
    const definition = {
      id: 12,
      name: 'Other branches',
      source: 'kilo',
      enforcement,
      rules: [{ type: 'required_signatures' }],
    } satisfies Repos['getRepoRuleset']['response']['data'];
    expect(normalize([], [definition])).toMatchObject({
      items: [],
      completeness: 'unknown',
      totalCount: null,
      source: { availability: 'unavailable' },
    });
  }
);

test.each([
  ['denied', false, 'forbidden'],
  ['unavailable', false, 'not_found'],
  ['unavailable', true, 'deadline'],
  ['partial', true, 'pagination-incomplete'],
  ['stale', true, 'revision-mismatch'],
] satisfies [GitHubPrReviewSource['availability'], boolean, string][])(
  'preserves %s evidence and retry metadata',
  (availability, retryable, reason) => {
    const failed = { ...rules(), source: { ...rules().source, availability, retryable, reason } };
    const malformed = { ...failed, items: [null] };
    for (const [classicSource, rulesSource] of [
      [failed, rules()],
      [classic(), failed],
      [classic(), malformed],
    ] as const) {
      const empty = normalizeContextPolicies(revision, classicSource, rulesSource);
      expect(empty).toMatchObject({
        items: [],
        completeness: 'unknown',
        totalCount: null,
        source: {
          availability: availability === 'partial' ? 'unavailable' : availability,
          retryable,
          reason,
        },
      });
    }
    const partial = normalizeContextPolicies(revision, classic([protection]), {
      ...rules([signature]),
      source: failed.source,
    });
    expect(partial).toMatchObject({
      completeness: 'partial',
      totalCount: null,
      source: { availability: availability === 'stale' ? 'stale' : 'partial', retryable, reason },
    });
    expect(
      partial.items.filter(item => item.check === null).map(item => item.policy?.source)
    ).toEqual(['classic', 'ruleset']);
  }
);

test.each([
  [{ contexts: ['ci'] }, { kind: 'unknown' }],
  [{ checks: [{ context: 'ci', app_id: 7 }] }, { kind: 'app', appId: 7 }],
])('keeps partial check configuration %j retryable', (configuration, application) => {
  const result = normalize([{ required_status_checks: { strict: true, ...configuration } }], []);
  expect(result).toMatchObject({
    completeness: 'partial',
    totalCount: null,
    source: { retryable: true },
  });
  expect(result.items.flatMap(item => (item.check ? [item.check] : []))).toEqual([
    { name: 'ci', kind: 'unknown', application },
  ]);
});

test.each([{}, { parameters: null }])(
  'keeps missing required-check parameters incomplete (%j)',
  configuration => {
    const result = normalize([], [{ ...origin, type: 'required_status_checks', ...configuration }]);
    expect(result).toMatchObject({
      completeness: 'partial',
      knownCount: 1,
      totalCount: null,
      source: {
        availability: 'partial',
        retryable: true,
        reason: 'invalid-policy-data',
        observedAt,
        provenance: ['rest.branchProtection', 'rest.branchRules'],
      },
      items: [
        {
          kind: 'required_status_checks',
          state: 'unavailable',
          check: null,
          policy: {
            source: 'ruleset',
            ruleType: 'required_status_checks',
            parameters: null,
            ruleset: { id: 12, source: 'kilo', sourceType: 'Organization' },
          },
        },
      ],
    });
  }
);

test('keeps an explicit empty required-check list complete without evaluating it', () => {
  const rule = {
    ...origin,
    type: 'required_status_checks',
    parameters: {
      strict_required_status_checks_policy: true,
      required_status_checks: [],
    },
  } satisfies Repos['getBranchRules']['response']['data'][number];
  expect(normalize([], [rule])).toMatchObject({
    completeness: 'complete',
    knownCount: 1,
    totalCount: 1,
    source: { availability: 'available', retryable: false, reason: null },
    items: [
      {
        kind: 'required_status_checks',
        state: 'unavailable',
        check: null,
        policy: { parameters: rule.parameters },
      },
    ],
  });
});

test('confirms empty policies only when both sources explicitly prove absence', () => {
  expect(normalize([], [])).toMatchObject({
    items: [],
    completeness: 'complete',
    totalCount: 0,
    source: { availability: 'available' },
  });
  for (const raw of [null, {}, { url: 'https://api.github.com/protection' }]) {
    expect(normalize([raw], [])).toMatchObject({
      items: [],
      completeness: 'unknown',
      totalCount: null,
    });
  }
});

test.each([
  { completeness: 'partial' as const },
  { completeness: 'unknown' as const },
  { knownCount: 1 },
  { totalCount: 1 },
  { hasNextPage: null },
])('rejects incomplete empty evidence %j', metadata => {
  expect(normalizeContextPolicies(revision, classic(), { ...rules(), ...metadata })).toMatchObject({
    completeness: 'unknown',
    totalCount: null,
  });
});

test('preserves unfinished pagination', () => {
  const result = normalizeContextPolicies(revision, classic(), {
    ...rules(),
    hasNextPage: true,
    endCursor: 'next',
  });
  expect(result).toMatchObject({
    completeness: 'unknown',
    totalCount: null,
    hasNextPage: true,
    endCursor: 'next',
  });
});

test.each([
  null,
  { type: '' },
  { type: 'future', parameters: { invalid: Infinity } },
  {
    id: 4,
    ref: 'refs/heads/release/1',
    before_sha: 'old',
    after_sha: 'base',
    result: 'pass',
    evaluation_result: 'pass',
  },
])('rejects malformed or historical evidence %j', raw => {
  const parameters = { nested: [{ enabled: false, limit: 3, value: null }] };
  const result = normalize([], [{ ...origin, type: 'future_rule', parameters }, raw]);
  expect(result).toMatchObject({ completeness: 'partial', totalCount: null });
  expect(result.items[0]).toMatchObject({
    kind: 'future_rule',
    state: 'unavailable',
    policy: { parameters },
  });
});

test('does not invent a missing base identity', () => {
  const incompleteBase = { ...base, baseRepoFullName: null, baseSha: null };
  const result = normalizeContextPolicies(
    { ...revision, ...incompleteBase },
    classic(),
    rules([signature])
  );
  expect(result.completeness).toBe('partial');
  expect(result.items[0]?.policy?.base).toEqual(incompleteBase);
});

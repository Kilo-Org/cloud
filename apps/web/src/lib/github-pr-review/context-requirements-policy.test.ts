import { GitHubPrReviewRequirementSchema } from './context-dtos';
import { expandPolicy } from './context-requirements';

const requirement = (source: 'classic' | 'ruleset', ruleType: string, parameters: unknown) =>
  GitHubPrReviewRequirementSchema.parse({
    id: 'policy',
    kind: ruleType,
    title: ruleType,
    state: 'unavailable',
    check: null,
    policy: {
      id: 'policy',
      source,
      enforcement: 'active',
      ruleType,
      parameters,
      base: { baseRepoFullName: 'kilo/upstream', baseRef: 'release/1', baseSha: 'base' },
      ruleset: source === 'ruleset' ? { id: 12, source: 'kilo', sourceType: 'Organization' } : null,
    },
    evidence: [
      {
        source: source === 'classic' ? 'rest.branchProtection' : 'rest.branchRules',
        policyId: 'policy',
        observation: 'policy-configuration',
        headSha: 'head',
        baseSha: 'base',
        evaluatedSha: null,
        observedAt: '2026-08-29T12:00:00Z',
      },
    ],
  });

function expectKinds(item: ReturnType<typeof requirement>, kinds: string[]) {
  const rows = expandPolicy(item);
  expect(rows.map(row => row.kind)).toEqual(kinds);
  for (const row of rows) {
    expect(row.state).toBe('unavailable');
    expect(row.policy).toEqual(item.policy);
    expect(row.evidence).toEqual(item.evidence);
  }
  return rows;
}

it('names each classic requirement and retains its exact configuration evidence', () => {
  const item = requirement('classic', 'branch_protection', {
    required_status_checks: {
      strict: true,
      checks: [{ context: 'ci', app_id: 7 }],
      contexts: ['ci'],
    },
    required_pull_request_reviews: {
      required_approving_review_count: 2,
      require_code_owner_reviews: true,
      require_last_push_approval: true,
      dismiss_stale_reviews: true,
    },
    required_conversation_resolution: { enabled: true },
    required_deployments: {
      required_deployment_environments: ['preview', 'production', 'preview'],
    },
    required_signatures: { enabled: true },
    required_linear_history: true,
    lock_branch: { enabled: true },
    block_creations: true,
    restrictions: { users: [], teams: [], apps: [] },
    future_rule: { nested: [null, { limit: 3 }] },
  });
  const rows = expectKinds(item, [
    'branch-freshness',
    'approving-reviews',
    'code-owner-reviews',
    'last-push-approval',
    'stale-review-dismissal',
    'conversation-resolution',
    'deployment',
    'deployment',
    'commit-signatures',
    'linear-history',
    'locked-branch',
    'branch-creation',
    'push-restrictions',
    'future_rule',
  ]);
  expect(rows.map(row => row.title)).toEqual([
    'Branch must be up to date',
    'Required approving reviews',
    'Code owner reviews',
    'Approval of the last push',
    'Stale review dismissal',
    'Resolved review conversations',
    'preview',
    'production',
    'Signed commits',
    'Linear history',
    'Unlocked branch',
    'Branch creation restrictions',
    'Push restrictions',
    'future_rule',
  ]);
  expect(new Set(rows.map(row => row.id)).size).toBe(rows.length);
});

it.each([
  [
    'required_status_checks',
    {
      required_status_checks: [],
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
    },
    [],
  ],
  [
    'pull_request',
    {
      required_approving_review_count: 3,
      require_code_owner_review: true,
      require_last_push_approval: true,
      dismiss_stale_reviews_on_push: true,
      required_review_thread_resolution: true,
      allowed_merge_methods: ['squash'],
      future_parameter: { nested: ['unknown'] },
    },
    [
      'approving-reviews',
      'code-owner-reviews',
      'last-push-approval',
      'stale-review-dismissal',
      'conversation-resolution',
      'allowed-merge-methods',
    ],
  ],
  [
    'required_deployments',
    { required_deployment_environments: ['production', 'staging'] },
    ['deployment', 'deployment'],
  ],
] as const)(
  'expands inherited %s without losing parameters or provenance',
  (kind, parameters, kinds) => {
    const item = requirement('ruleset', kind, parameters);
    const rows = expectKinds(item, [...kinds]);
    if (kind === 'required_deployments')
      expect(rows.map(row => row.title)).toEqual(['production', 'staging']);
  }
);

it.each([
  { kind: 'app', appId: 7 },
  { kind: 'app', appId: 8 },
  { kind: 'any' },
  { kind: 'unknown' },
] as const)('preserves the named check and its exact binding %j', application => {
  const item = {
    ...requirement('classic', 'branch_protection', { required_status_checks: { strict: true } }),
    kind: 'status-check',
    title: 'ci',
    check: { name: 'ci', kind: 'unknown' as const, application },
  };
  expect(expandPolicy(item)).toEqual([item]);
});

it.each(['required_signatures', 'workflows', 'code_scanning', 'future_rule'])(
  'keeps unsupported %s named and unavailable',
  kind => {
    const item = requirement('ruleset', kind, { opaque: [{ value: null, enabled: true }] });
    expect(expandPolicy(item)).toEqual([item]);
  }
);

it('retains malformed classic configuration as named unavailable requirements', () => {
  const item = requirement('classic', 'branch_protection', {
    required_status_checks: 'invalid',
    required_pull_request_reviews: {
      required_approving_review_count: '2',
      require_code_owner_reviews: null,
    },
    required_deployments: { required_deployment_environments: ['production', null] },
    required_signatures: null,
  });
  expectKinds(item, [
    'status-policy',
    'approving-reviews',
    'review-policy',
    'deployment-policy',
    'commit-signatures',
  ]);
});

it.each(['2', -1, 0.5, null])('does not treat invalid approval count %p as zero', count => {
  expectKinds(
    requirement('ruleset', 'pull_request', {
      required_approving_review_count: count,
      require_code_owner_review: false,
      require_last_push_approval: false,
      dismiss_stale_reviews_on_push: false,
    }),
    ['approving-reviews']
  );
});

it.each([
  ['required_status_checks', 'status-policy'],
  ['pull_request', 'approving-reviews'],
  ['required_deployments', 'required_deployments'],
])('does not turn missing %s parameters into an empty result', (kind, expected) => {
  expectKinds(requirement('ruleset', kind, null), [expected]);
});

it.each([
  ['classic', false],
  ['classic', true],
  ['ruleset', false],
  ['ruleset', true],
] as const)('accepts supported empty %s checks with strict %p', (source, strict) => {
  const item =
    source === 'classic'
      ? requirement(source, 'branch_protection', {
          required_status_checks: { strict, checks: [], contexts: [] },
          required_pull_request_reviews: {
            required_approving_review_count: 0,
            require_code_owner_reviews: false,
            require_last_push_approval: false,
            dismiss_stale_reviews: false,
          },
          required_conversation_resolution: { enabled: false },
          required_deployments: { required_deployment_environments: [] },
          required_signatures: { enabled: false },
          required_linear_history: false,
          lock_branch: { enabled: false },
          block_creations: false,
        })
      : requirement(source, 'required_status_checks', {
          required_status_checks: [],
          strict_required_status_checks_policy: strict,
        });
  expect(expandPolicy(item)).toEqual([]);
});

it('retains strict freshness for a configured ruleset check', () => {
  expectKinds(
    requirement('ruleset', 'required_status_checks', {
      required_status_checks: [{ context: 'ci', integration_id: 7 }],
      strict_required_status_checks_policy: true,
      do_not_enforce_on_create: false,
    }),
    ['branch-freshness']
  );
});

it.each([{ enabled: 'invalid' }, 'invalid', {}, null])(
  'retains malformed classic conversations %j beside supported empty checks',
  conversation => {
    const item = requirement('classic', 'branch_protection', {
      required_status_checks: { strict: false, checks: [], contexts: [] },
      required_conversation_resolution: conversation,
    });
    expectKinds(item, ['conversation-resolution']);
  }
);

it.each([false, true])(
  'retains unknown ruleset status parameters beside empty checks with strict %p',
  strict => {
    const item = requirement('ruleset', 'required_status_checks', {
      required_status_checks: [],
      strict_required_status_checks_policy: strict,
      future_parameter: { nested: ['unknown'] },
    });
    expectKinds(item, ['status-policy']);
  }
);

it.each([
  ['classic', { strict: false, checks: [null], contexts: [] }, ['status-policy']],
  ['classic', { strict: true, checks: [], contexts: null }, ['branch-freshness', 'status-policy']],
  [
    'ruleset',
    { strict_required_status_checks_policy: true },
    ['branch-freshness', 'status-policy'],
  ],
  [
    'ruleset',
    { strict_required_status_checks_policy: false, required_status_checks: [{ context: '' }] },
    ['status-policy'],
  ],
  [
    'ruleset',
    {
      strict_required_status_checks_policy: false,
      required_status_checks: [],
      do_not_enforce_on_create: 'invalid',
    },
    ['status-policy'],
  ],
] as const)('retains uncertain %s status configuration %j', (source, parameters, kinds) => {
  const item =
    source === 'classic'
      ? requirement(source, 'branch_protection', { required_status_checks: parameters })
      : requirement(source, 'required_status_checks', parameters);
  expectKinds(item, [...kinds]);
});

it('preserves a requirement when its policy is unavailable', () => {
  const item = { ...requirement('ruleset', 'future_rule', null), policy: null };
  expect(expandPolicy(item)).toEqual([item]);
});

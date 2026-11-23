import { OrganizationGroupPoliciesSchema } from '../organization-group-policies';
import {
  MemberAgentPermissionsSchema,
  MemberPermissionPolicySchema,
  OrganizationPermissionPolicySchema,
} from './permission-policy.schema';
import type * as z from 'zod';
import fixtures from './v1-fixtures.json';

test.each([fixtures.layered, fixtures.enabled_empty, fixtures.disabled])(
  'round trips the supported member fixture without rewriting its rules or omissions ($revision, $managed)',
  fixture => {
    expect(MemberPermissionPolicySchema.parse(fixture)).toStrictEqual(fixture);
  }
);

test('fails closed for a newer wire version, invalid managed state, and excessive freshness', () => {
  for (const response of [
    fixtures.invalid_future_version,
    { ...fixtures.enabled_empty, managed: null },
    { ...fixtures.enabled_empty, max_age_seconds: 301 },
    { ...fixtures.layered, managed: false },
  ]) {
    expect(MemberPermissionPolicySchema.safeParse(response).success).toBe(false);
  }
});

test('retains explicit empty shell maps, unknown tool keys, and absent fallbacks in mixed storage', () => {
  const policies = [
    { type: 'model_access', data: { mode: 'all' } },
    {
      type: 'agent_permissions',
      data: { schema_version: 1, shell: {}, tools: { custom_tool: { rules: [] }, bash: 'ask' } },
    },
  ];
  expect(OrganizationGroupPoliciesSchema.parse(policies)).toStrictEqual(policies);
  expect(OrganizationGroupPoliciesSchema.safeParse([...policies, policies[1]]).success).toBe(false);
});

test.each([
  { bash: { fallback: 'allow', rules: [] } },
  { bash: { rules: [] } },
  { cmd: { fallback: 'deny', rules: [] } },
])('rejects invalid shell profiles: %j', shell => {
  expect(
    OrganizationPermissionPolicySchema.safeParse({
      type: 'agent_permissions',
      data: { schema_version: 1, shell },
    }).success
  ).toBe(false);
});

test('rejects the retired client-access policy in active contracts', () => {
  const retired = {
    type: 'client_access',
    data: { schema_version: 1, mode: 'allowlist', clients: [{ feature: 'cli' }] },
  };
  expect(OrganizationPermissionPolicySchema.safeParse(retired).success).toBe(false);
  expect(OrganizationGroupPoliciesSchema.safeParse([retired]).success).toBe(false);
  expect(
    MemberPermissionPolicySchema.safeParse({
      ...fixtures.enabled_empty,
      policy: { client_access: { layers: [retired.data] } },
    }).success
  ).toBe(false);
});

test('rejects oversized stored documents and effective policies instead of dropping layers', () => {
  const rules = Array.from({ length: 40 }, () => ({ pattern: 'x'.repeat(500), action: 'allow' }));
  const layer = { schema_version: 1, shell: { bash: { fallback: 'ask', rules } } };
  const oversizedLayer = { ...layer, shell: { ...layer.shell, powershell: layer.shell.bash } };
  expect(
    OrganizationPermissionPolicySchema.safeParse({ type: 'agent_permissions', data: layer }).success
  ).toBe(true);
  expect(
    OrganizationPermissionPolicySchema.safeParse({
      type: 'agent_permissions',
      data: oversizedLayer,
    }).success
  ).toBe(false);
  expect(
    MemberPermissionPolicySchema.safeParse({
      ...fixtures.enabled_empty,
      policy: { agent_permissions: { layers: Array.from({ length: 15 }, () => layer) } },
    }).success
  ).toBe(false);
});

type Layer = z.infer<typeof MemberAgentPermissionsSchema>['layers'][number];
type Rule = NonNullable<NonNullable<Layer['shell']>['bash']>['rules'][number];
type Action = Rule['action'];

/** The most restrictive of two decisions: `deny` over `ask` over `allow`. */
function restrict(left: Action | undefined, right: Action | undefined) {
  if (left === 'deny' || right === 'deny') return 'deny' as const;
  if (left === 'ask' || right === 'ask') return 'ask' as const;
  return left ?? right;
}

/** A pattern's `*` matches any run of characters; the pattern anchors at both ends. */
function ruleAction(rules: readonly Rule[], input: string, fallback?: Action) {
  const matched = rules.findLast(rule => {
    const source = rule.pattern
      .split('*')
      .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${source}$`).test(input);
  });
  return matched?.action ?? fallback;
}

type ShellKind = keyof NonNullable<Layer['shell']> | 'unsupported';

/**
 * The decision the schema comment at the `tools.bash` guard describes for one shell
 * command: both representations apply in every layer that states them, the more
 * restrictive outcome wins, and a layer that names no profile for the running shell
 * denies.
 */
function decideShell(layers: readonly Layer[], kind: ShellKind, command: string) {
  let decision: Action | undefined;
  for (const layer of layers) {
    const tool = layer.tools?.bash;
    if (typeof tool === 'string') decision = restrict(decision, tool);
    const profile = kind === 'unsupported' ? undefined : layer.shell?.[kind];
    if (layer.shell) {
      if (!profile) return 'deny' as const;
      decision = restrict(decision, ruleAction(profile.rules, command, profile.fallback));
    }
    if (decision === 'deny') return decision;
  }
  return decision;
}

function decideTool(layers: readonly Layer[], tool: string, resource?: string) {
  let decision: Action | undefined;
  for (const layer of layers) {
    const value = layer.tools?.[tool];
    if (value === undefined) continue;
    if (typeof value === 'string') decision = restrict(decision, value);
    else if (resource === undefined) decision = restrict(decision, value.fallback);
    else decision = restrict(decision, ruleAction(value.rules, resource, value.fallback));
  }
  return decision;
}

/** The shell a fixture expectation names, kept to the kinds a profile may hold. */
function shellKind(kind: string) {
  if (kind === 'bash' || kind === 'powershell') return kind;
  throw new Error(`Unexpected shell kind: ${kind}`);
}

/** The layers of a managed fixture, read through the schemas rather than cast. */
function managedLayers(fixture: unknown): readonly Layer[] {
  const member = MemberPermissionPolicySchema.parse(fixture);
  if (!member.managed) throw new Error('Expected a managed member policy');
  return MemberAgentPermissionsSchema.parse(member.policy.agent_permissions).layers;
}

// These mirrors are evidence only when they reproduce the decisions the fixtures
// already record, so this test runs first.
test('reproduces the recorded layered decisions before judging a new fixture', () => {
  const layers: readonly Layer[] = managedLayers(fixtures.layered);
  for (const entry of fixtures.layered_expectations.shell) {
    expect(decideShell(layers, shellKind(entry.kind), entry.command)).toBe(entry.decision);
  }
  for (const entry of fixtures.layered_expectations.tools) {
    // `inherit` is the fixture's name for the policy stating no decision at all.
    const resource = 'resource' in entry ? entry.resource : undefined;
    expect(decideTool(layers, entry.tool, resource) ?? 'inherit').toBe(entry.decision);
  }
});

test('keeps a layer Bash default and its shell profile both in force', () => {
  expect(
    MemberPermissionPolicySchema.parse(fixtures.layered_bash_action_and_profile)
  ).toStrictEqual(fixtures.layered_bash_action_and_profile);

  const layers: readonly Layer[] = managedLayers(fixtures.layered_bash_action_and_profile);
  for (const entry of fixtures.layered_bash_action_and_profile_expectations.shell) {
    expect(decideShell(layers, shellKind(entry.kind), entry.command)).toBe(entry.decision);
  }

  // Each single-layer case below separates the documented combination from an
  // override in either direction.
  const toolDenyOverAllowingProfile: Layer[] = [
    {
      schema_version: 1,
      tools: { bash: 'deny' },
      shell: { bash: { fallback: 'ask', rules: [{ pattern: 'ls *', action: 'allow' }] } },
    },
  ];
  expect(decideShell(toolDenyOverAllowingProfile, 'bash', 'ls -la')).toBe('deny');

  const allowingToolOverAskingProfile: Layer[] = [
    {
      schema_version: 1,
      tools: { bash: 'allow' },
      shell: { bash: { fallback: 'ask', rules: [] } },
    },
  ];
  expect(decideShell(allowingToolOverAskingProfile, 'bash', 'make release')).toBe('ask');

  const profileForAnotherShell: Layer[] = [
    {
      schema_version: 1,
      tools: { bash: 'allow' },
      shell: { powershell: { fallback: 'ask', rules: [] } },
    },
  ];
  expect(decideShell(profileForAnotherShell, 'bash', 'ls -la')).toBe('deny');

  // A layer with no shell block leaves Bash to its tools entry; a layer that has
  // one denies a command whose shell cannot be parsed.
  const toolOnlyLayer: Layer[] = [{ schema_version: 1, tools: { bash: 'allow' } }];
  expect(decideShell(toolOnlyLayer, 'bash', 'ls -la')).toBe('allow');
  expect(decideShell(toolOnlyLayer, 'unsupported', 'ls -la')).toBe('allow');
  expect(decideShell(layers.slice(0, 1), 'unsupported', 'ls -la')).toBe('deny');

  // The shell rules still decide the commands they describe.
  expect(decideShell(layers.slice(0, 1), 'bash', 'git status --short')).toBe('allow');
  expect(decideShell(layers.slice(0, 1), 'bash', 'git push origin main')).toBe('deny');
});

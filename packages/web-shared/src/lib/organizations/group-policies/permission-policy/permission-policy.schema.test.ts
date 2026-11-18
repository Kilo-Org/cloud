import { OrganizationGroupPoliciesSchema } from '../organization-group-policies';
import {
  MemberPermissionPolicySchema,
  OrganizationPermissionPolicySchema,
} from './permission-policy.schema';
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
    { type: 'client_access', data: fixtures.layered.policy.client_access.layers[0] },
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

test.each([
  { mode: 'allowlist', clients: [], unknown_clients: 'allow' },
  { mode: 'allowlist', clients: [{ feature: 'unrecognized' }] },
  { mode: 'allowlist', clients: [{ feature: 'cli', min_version: '1.2.3-01' }] },
  { mode: 'allowlist', clients: [{ feature: 'cli' }, { feature: 'cli' }] },
  { mode: 'blocklist', clients: [{ feature: 'cli', min_version: '1.2.3' }] },
])('rejects an invalid client admission predicate: %j', policy => {
  expect(
    OrganizationPermissionPolicySchema.safeParse({
      type: 'client_access',
      data: { schema_version: 1, ...policy },
    }).success
  ).toBe(false);
});

test('accepts a full SemVer including prerelease and build metadata', () => {
  expect(
    OrganizationPermissionPolicySchema.safeParse({
      type: 'client_access',
      data: {
        schema_version: 1,
        mode: 'allowlist',
        clients: [{ feature: 'cli', min_version: '1.2.3-beta.1+build.009' }],
      },
    }).success
  ).toBe(true);
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

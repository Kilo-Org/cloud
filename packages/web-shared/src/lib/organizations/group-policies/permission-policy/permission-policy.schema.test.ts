import { MAX_ORGANIZATION_GROUPS } from '@kilocode/db/schema-types';
import { OrganizationGroupPoliciesSchema } from '../organization-group-policies';
import {
  MemberPermissionPolicySchema,
  OrganizationPermissionPolicySchema,
  PERMISSION_POLICY_OS_ADDITIONS,
  PermissionPolicyExecutionOsSchema,
} from './permission-policy.schema';
import fixtures from './v1-fixtures.json';

test.each([
  fixtures.layered,
  fixtures.scoped_auto_approve,
  fixtures.enabled_empty,
  fixtures.disabled,
])(
  'round trips the supported member fixture without rewriting its rules or omissions ($revision, $managed)',
  fixture => {
    const parsed = MemberPermissionPolicySchema.parse(fixture);
    expect(parsed).toStrictEqual(fixture);
    expect(JSON.stringify(parsed.policy)).toBe(JSON.stringify(fixture.policy));
  }
);

test.each(Object.entries(fixtures.os_scoped.responses))(
  'round trips the revision 14 member response for %s',
  (_selector, fixture) => {
    const parsed = MemberPermissionPolicySchema.parse(fixture);
    expect(parsed).toStrictEqual(fixture);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(fixture));
  }
);

test('round trips the revision 14 stored sources in both persisted and admin schemas', () => {
  const { default_policies, groups } = fixtures.os_scoped.sources;
  for (const source of [default_policies, ...groups]) {
    expect(OrganizationGroupPoliciesSchema.parse(source)).toStrictEqual(source);
    expect(source.map(policy => OrganizationPermissionPolicySchema.parse(policy))).toStrictEqual(
      source
    );
  }
});

test('accepts the three authorable selectors and other only as a canonical execution OS', () => {
  expect(PERMISSION_POLICY_OS_ADDITIONS).toStrictEqual(['linux', 'macos', 'windows']);
  for (const os of [...PERMISSION_POLICY_OS_ADDITIONS, 'other']) {
    expect(PermissionPolicyExecutionOsSchema.parse(os)).toBe(os);
  }
  for (const os of ['', 'Windows', 'win32', 'darwin', 'freebsd', 'all', 'linux ', null]) {
    expect(PermissionPolicyExecutionOsSchema.safeParse(os).success).toBe(false);
  }
});

test('retains empty sets, ordered rules, and omissions in OS-scoped authoring', () => {
  const policy = {
    type: 'agent_permissions',
    data: {
      schema_version: 1,
      by_os: {
        linux: { shell: {} },
        macos: {
          tools: {
            webfetch: {
              rules: [
                { pattern: '*', action: 'ask' },
                { pattern: 'docs.example.test/*', action: 'allow' },
              ],
            },
          },
        },
        windows: {},
      },
    },
  };
  expect(OrganizationPermissionPolicySchema.parse(policy)).toStrictEqual(policy);
  const empty = { type: 'agent_permissions', data: { schema_version: 1, by_os: {} } };
  expect(OrganizationPermissionPolicySchema.parse(empty)).toStrictEqual(empty);
});

test.each([
  null,
  { other: {} },
  { freebsd: {} },
  { Windows: {} },
  Object.fromEntries([['__proto__', {}]]),
  { linux: null },
  { linux: { schema_version: 1 } },
  { macos: { unknown: true } },
  { windows: { by_os: { linux: {} } } },
])('rejects invalid stored by_os data: %j', by_os => {
  const policy = { type: 'agent_permissions', data: { schema_version: 1, by_os } };
  expect(OrganizationPermissionPolicySchema.safeParse(policy).success).toBe(false);
  expect(OrganizationGroupPoliciesSchema.safeParse([policy]).success).toBe(false);
});

test.each(['allow', 'ask', true, false, null])(
  'rejects an invalid auto-approval value: %j',
  auto_approve => {
    const data = { schema_version: 1, auto_approve };
    expect(
      OrganizationGroupPoliciesSchema.safeParse([{ type: 'agent_permissions', data }]).success
    ).toBe(false);
    expect(
      OrganizationPermissionPolicySchema.safeParse({
        type: 'agent_permissions',
        data: { schema_version: 1, by_os: { windows: { auto_approve } } },
      }).success
    ).toBe(false);
    expect(
      MemberPermissionPolicySchema.safeParse({
        ...fixtures.enabled_empty,
        policy: { agent_permissions: { layers: [data] } },
      }).success
    ).toBe(false);
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

test('retains model access, explicit empty shell maps and absent fallbacks in mixed storage', () => {
  const configuration = {
    type: 'client_configuration',
    data: { schema_version: 1, show_session_dollar_values: true },
  };
  const policies = [
    { type: 'model_access', data: { mode: 'all' } },
    {
      type: 'agent_permissions',
      data: { schema_version: 1, shell: {}, tools: { custom_tool: { rules: [] }, bash: 'ask' } },
    },
    configuration,
  ];
  expect(OrganizationGroupPoliciesSchema.parse(policies)).toStrictEqual(policies);
  expect(OrganizationGroupPoliciesSchema.safeParse([...policies, policies[1]]).success).toBe(false);
  expect(OrganizationGroupPoliciesSchema.safeParse([...policies, configuration]).success).toBe(
    false
  );
});

test.each([
  ['Bash fallback allow', { shell: { bash: { fallback: 'allow', rules: [] } } }],
  ['missing Bash fallback', { shell: { bash: { rules: [] } } }],
  ['unsupported cmd profile', { shell: { cmd: { fallback: 'deny', rules: [] } } }],
  ['Bash command rules in tools', { tools: { bash: { rules: [] } } }],
  ['invalid tool key', { tools: { 'invalid key': 'deny' } }],
  [
    'more than 100 tools',
    { tools: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`tool_${i}`, 'ask'])) },
  ],
  [
    'more than 100 resource rules',
    { tools: { webfetch: { rules: Array(101).fill({ pattern: '*', action: 'ask' }) } } },
  ],
])('rejects %s in a baseline, an OS addition, and a member layer', (_reason, permissions) => {
  expect(
    OrganizationPermissionPolicySchema.safeParse({
      type: 'agent_permissions',
      data: { schema_version: 1, ...permissions },
    }).success
  ).toBe(false);
  expect(
    OrganizationPermissionPolicySchema.safeParse({
      type: 'agent_permissions',
      data: { schema_version: 1, by_os: { linux: permissions } },
    }).success
  ).toBe(false);
  expect(
    MemberPermissionPolicySchema.safeParse({
      ...fixtures.enabled_empty,
      policy: { agent_permissions: { layers: [{ schema_version: 1, ...permissions }] } },
    }).success
  ).toBe(false);
});

test.each([true, false])('accepts a config-only response with visibility %j', show => {
  const response = {
    ...fixtures.enabled_empty,
    policy: { client_configuration: { show_session_dollar_values: show } },
  };
  expect(MemberPermissionPolicySchema.parse(response)).toStrictEqual(response);
  expect(MemberPermissionPolicySchema.safeParse({ ...response, managed: false }).success).toBe(
    false
  );
});

test.each([
  {},
  { show_session_dollar_values: null },
  { show_session_dollar_values: 'false' },
  { show_session_dollar_values: 0 },
  { show_session_dollar_values: true, by_os: { windows: { show_session_dollar_values: false } } },
  { show_session_dollar_values: false, tools: { edit: 'deny' } },
])('rejects invalid or extended client settings in storage and on the wire: %j', config => {
  const policy = { type: 'client_configuration', data: { schema_version: 1, ...config } };
  expect(OrganizationPermissionPolicySchema.safeParse(policy).success).toBe(false);
  expect(OrganizationGroupPoliciesSchema.safeParse([policy]).success).toBe(false);
  expect(
    MemberPermissionPolicySchema.safeParse({
      ...fixtures.enabled_empty,
      policy: { client_configuration: config },
    }).success
  ).toBe(false);
});

test('requires schema version 1 on both stored branches', () => {
  for (const schema_version of [undefined, 2]) {
    expect(
      OrganizationPermissionPolicySchema.safeParse({
        type: 'agent_permissions',
        data: { schema_version, by_os: { windows: {} } },
      }).success
    ).toBe(false);
    expect(
      OrganizationPermissionPolicySchema.safeParse({
        type: 'client_configuration',
        data: { schema_version, show_session_dollar_values: false },
      }).success
    ).toBe(false);
  }
});

test.each([
  { agent_permissions: { layers: [] } },
  { agent_permissions: { layers: [{ tools: { browser_open: 'ask' } }] } },
  { agent_permissions: { layers: [{ schema_version: 1, by_os: {} }] } },
  { agent_permissions: { layers: [{ schema_version: 1, group_id: 'source' }] } },
  { client_configuration: { schema_version: 1, show_session_dollar_values: false } },
  { client_configuration: { data: { show_session_dollar_values: false } } },
])('rejects non-flat or source-bearing member policy data: %j', policy => {
  expect(
    MemberPermissionPolicySchema.safeParse({ ...fixtures.enabled_empty, policy }).success
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

test('limits flat layers to two per possible policy source', () => {
  const maxLayers = 2 * (MAX_ORGANIZATION_GROUPS + 1);
  const layers = Array.from({ length: maxLayers }, (_, i) => ({
    schema_version: 1,
    tools: { [`tool_${i}`]: 'ask' },
  }));
  const response = { ...fixtures.enabled_empty, policy: { agent_permissions: { layers } } };
  expect(MemberPermissionPolicySchema.parse(response)).toStrictEqual(response);
  expect(
    MemberPermissionPolicySchema.safeParse({
      ...response,
      policy: { agent_permissions: { layers: [...layers, { schema_version: 1 }] } },
    }).success
  ).toBe(false);
});

test('counts baseline and all OS additions together toward the 32 KiB UTF-8 limit', () => {
  const rules = Array.from({ length: 20 }, () => ({
    pattern: '\u00e9'.repeat(500),
    action: 'ask',
  }));
  const permissions = { shell: { bash: { fallback: 'ask', rules } } };
  const baseline = { schema_version: 1, ...permissions };
  const scoped = { schema_version: 1, by_os: { windows: permissions } };
  for (const data of [baseline, scoped]) {
    expect(
      OrganizationPermissionPolicySchema.safeParse({ type: 'agent_permissions', data }).success
    ).toBe(true);
  }
  expect(
    OrganizationPermissionPolicySchema.safeParse({
      type: 'agent_permissions',
      data: { ...baseline, by_os: scoped.by_os },
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
      policy: { agent_permissions: { layers: [oversizedLayer] } },
    }).success
  ).toBe(false);
  expect(
    MemberPermissionPolicySchema.safeParse({
      ...fixtures.enabled_empty,
      policy: { agent_permissions: { layers: Array.from({ length: 15 }, () => layer) } },
    }).success
  ).toBe(false);
});

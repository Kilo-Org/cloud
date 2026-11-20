import fixtures from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/v1-fixtures.json';
import {
  parsePermissionPolicyDocument,
  reviewPermissionPolicyImport,
  validateAgentPermissionPolicy,
} from './permission-policy-import';

const agentType = 'agent_permissions';
const agentDocument = (data: object) =>
  JSON.stringify({ type: agentType, data: { schema_version: 1, ...data } });
const retiredPolicy = {
  type: 'client_access',
  data: { schema_version: 1, mode: 'allowlist', clients: [{ feature: 'cli' }] },
};

describe.each([parsePermissionPolicyDocument, reviewPermissionPolicyImport])('%p', parse => {
  test.each([
    ...fixtures.layered.policy.agent_permissions.layers,
    ...fixtures.scoped_auto_approve.policy.agent_permissions.layers,
  ])('round trips agent permissions producer fixture %# without altering its policy data', data => {
    const policy = { type: agentType, data };
    const text = `{
      // Comments, braces [{, and trailing commas are supported.
      "type": "${agentType}",
      "data": ${JSON.stringify(data)},
    }`;
    expect(parse(text)).toStrictEqual({ status: 'valid', source: 'native', policy, warnings: [] });
  });

  test('round trips All OS and every authored OS set in one native document', () => {
    const data = {
      schema_version: 1,
      tools: { browser_open: 'ask' },
      shell: {},
      by_os: {
        linux: {},
        macos: { auto_approve: 'deny' },
        windows: {
          tools: { browser_open: 'deny' },
          shell: {
            powershell: {
              fallback: 'ask',
              rules: [
                { pattern: '*', action: 'deny' },
                { pattern: 'Get-ChildItem*', action: 'allow' },
              ],
            },
          },
        },
      },
    };
    expect(parse(agentDocument(data))).toStrictEqual({
      status: 'valid',
      source: 'native',
      policy: { type: agentType, data },
      warnings: [],
    });
  });

  test.each([
    { other: {} },
    { windows: { schema_version: 1 } },
    { windows: { by_os: { linux: {} } } },
  ])('rejects unsupported OS set shapes: %j', by_os => {
    expect(parse(agentDocument({ by_os }))).toMatchObject({ status: 'invalid' });
  });

  test('rejects duplicate decoded OS keys', () => {
    const text =
      '{"type":"agent_permissions","data":{"schema_version":1,"by_os":{"windows":{},"wind\\u006fws":{}}}}';
    expect(parse(text)).toEqual({
      status: 'invalid',
      errors: [expect.stringMatching(/^Duplicate property at line 1, column \d+\.$/)],
    });
  });

  test.each(['allow', true, null])('rejects invalid scoped auto-approval: %j', auto_approve => {
    expect(parse(agentDocument({ auto_approve }))).toEqual({
      status: 'invalid',
      errors: ['data.auto_approve: Invalid value.'],
    });
  });

  test.each(['{}', '{"type":"agent_permissions","data":', '{"bad":"\\q"}', '[]', 'null'])(
    'rejects non-policy or malformed input: %s',
    text => {
      expect(parse(text)).toMatchObject({
        status: 'invalid',
        errors: expect.arrayContaining([expect.any(String)]),
      });
    }
  );

  test('rejects decoded duplicates and locates them without repeating the property', () => {
    const text = `{
      "type": "agent_permissions",
      "data": {"schema_version": 1, "secret-name": 0, "secret-\\u006eame": 1}
    }`;
    expect(parse(text)).toEqual({
      status: 'invalid',
      errors: [expect.stringMatching(/^Duplicate property at line 3, column \d+\.$/)],
    });
  });

  test('rejects excessive raw UTF-8 bytes and nesting even in ignored sections', () => {
    expect(parse(`/* ${'\u00e9'.repeat(70_000)} */ {}`)).toEqual({
      status: 'invalid',
      errors: [expect.stringContaining('128 KiB')],
    });
    expect(parse(`{"ignored":${'['.repeat(1_000)}0${']'.repeat(1_000)}}`)).toEqual({
      status: 'invalid',
      errors: [expect.stringContaining('nested too deeply')],
    });
  });

  test('enforces the shared serialized-size limit as well as the raw input limit', () => {
    const rules = Array.from({ length: 90 }, (_, index) => ({
      pattern: `${index}${'x'.repeat(499)}`,
      action: 'allow',
    }));
    expect(parse(agentDocument({ shell: { bash: { fallback: 'ask', rules } } }))).toEqual({
      status: 'invalid',
      errors: ['Policy too large.'],
    });
  });

  test('checks the total size of independently valid All OS and OS-specific sets', () => {
    const rules = Array.from({ length: 40 }, (_, index) => ({
      pattern: `${index}${'x'.repeat(499)}`,
      action: 'allow',
    }));
    const set = { shell: { bash: { fallback: 'ask', rules } } };
    const by_os = { linux: set };
    expect(parse(agentDocument(set))).toMatchObject({ status: 'valid' });
    expect(parse(agentDocument({ by_os }))).toMatchObject({ status: 'valid' });
    expect(parse(agentDocument({ ...set, by_os }))).toEqual({
      status: 'invalid',
      errors: ['Policy too large.'],
    });
  });

  test('keeps an omitted shell map distinct from an explicit empty shell map', () => {
    expect(parse(agentDocument({}))).toStrictEqual({
      status: 'valid',
      source: 'native',
      policy: { type: agentType, data: { schema_version: 1 } },
      warnings: [],
    });
    expect(parse(agentDocument({ shell: {} }))).toStrictEqual({
      status: 'valid',
      source: 'native',
      policy: { type: agentType, data: { schema_version: 1, shell: {} } },
      warnings: [],
    });
  });

  test.each([
    { bash: { rules: [] } },
    { powershell: { fallback: 'allow', rules: [] } },
    { cmd: { fallback: 'deny', rules: [] } },
    { bash: { fallback: 'deny', rules: [], extra: 'secret-value' } },
  ])('rejects invalid native shell profiles: %j', shell => {
    expect(parse(agentDocument({ shell }))).toMatchObject({ status: 'invalid' });
  });

  test('rejects a well-formed retired client access policy', () => {
    expect(parse(JSON.stringify(retiredPolicy))).toMatchObject({
      status: 'invalid',
      errors: expect.arrayContaining(['type: Expected an agent_permissions policy document.']),
    });
  });

  test('rejects the valid client configuration policy type without falling back to local import', () => {
    const text = JSON.stringify({
      type: 'client_configuration',
      data: { schema_version: 1, show_session_dollar_values: false },
      permission: { edit: 'deny' },
    });
    expect(parse(text)).toMatchObject({
      status: 'invalid',
      errors: expect.arrayContaining(['type: Expected an agent_permissions policy document.']),
    });
  });

  test('rejects a member envelope and a future policy version', () => {
    expect(parse(JSON.stringify(fixtures.layered))).toMatchObject({ status: 'invalid' });
    expect(parse(agentDocument({ schema_version: 2 }))).toMatchObject({ status: 'invalid' });
  });

  test('formats validation issues without displaying supplied keys, patterns, or values', () => {
    const text = agentDocument({
      'secret-field': 'secret-value',
      tools: { 'secret-tool': { rules: [{ pattern: 'secret-pattern', action: 'secret-action' }] } },
    });
    const result = parse(text);
    expect(result).toMatchObject({ status: 'invalid' });
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(JSON.stringify(result)).toContain('data.tools[tool]');
  });

  test.each([
    [
      'the document root',
      '{"type":"agent_permissions","data":{"schema_version":1},"__proto__":null}',
    ],
    ['policy data', '{"type":"agent_permissions","data":{"schema_version":1,"__proto__":null}}'],
    ['the tool map', agentDocument({ tools: { ['__proto__']: 'deny' } })],
    ['a tool decision', agentDocument({ tools: { edit: { rules: [], ['__proto__']: null } } })],
    [
      'a rule object in an array',
      agentDocument({
        shell: {
          bash: {
            fallback: 'ask',
            rules: [{ pattern: 'example', action: 'deny', ['__proto__']: null }],
          },
        },
      }).replace('"__proto__"', '"__pr\\u006fto__"'),
    ],
  ])('rejects a reserved property in %s', (_, text) => {
    expect(parse(text)).toEqual({
      status: 'invalid',
      errors: [expect.stringMatching(/^Unsupported property at line \d+, column \d+\.$/)],
    });
  });

  test('allows a reserved key name as a string value', () => {
    const data = { tools: { edit: { rules: [{ pattern: '__proto__', action: 'deny' }] } } };
    expect(parse(agentDocument(data))).toEqual({
      status: 'valid',
      source: 'native',
      policy: { type: agentType, data: { schema_version: 1, ...data } },
      warnings: [],
    });
  });
});

test('formats OS-set draft validation like import without disclosing tool keys or values', () => {
  const draft = {
    type: agentType,
    data: {
      schema_version: 1,
      by_os: {
        windows: {
          tools: {
            'secret-tool': { rules: [{ pattern: 'secret-pattern', action: 'secret-action' }] },
          },
          shell: { powershell: { rules: [] } },
        },
      },
    },
  };
  const validation = validateAgentPermissionPolicy(draft);
  expect(validation).toStrictEqual(parsePermissionPolicyDocument(JSON.stringify(draft)));
  expect(validation).toMatchObject({
    status: 'invalid',
    errors: expect.arrayContaining([
      expect.stringContaining('data.by_os.windows.tools[tool]'),
      'data.by_os.windows.shell.powershell.fallback: Choose an explicit fallback for unlisted shell commands.',
    ]),
  });
  expect(JSON.stringify(validation)).not.toContain('secret-');
});

describe('legacy Kilo configuration', () => {
  test('does not import a local auto-approve preference as a managed restriction', () => {
    expect(
      reviewPermissionPolicyImport('{"autoApprove": true, "permission": {"edit": "ask"}}')
    ).toEqual({
      status: 'valid',
      source: 'local',
      policy: { type: agentType, data: { schema_version: 1, tools: { edit: 'ask' } } },
      warnings: [expect.stringMatching(/other configuration fields were ignored/i)],
    });
  });

  const text = `{
    "permission": {
      "edit": "deny",
      "external_directory": {"*": "deny", "10": "ask", "2": "allow", "/shared/*": "allow"},
      "bash": {"10": "deny", "*": "ask", "2": "allow", "git status *": "allow"},
    },
    "provider": {"secret-provider": {"secret-token": "secret-value"}},
    "mcp": {"secret-server": {}},
    "plugin": ["secret-plugin"],
    "agent": {"secret-agent": {"permission": {"edit": "allow"}}},
    "other": "secret-other"
  }`;
  const base = {
    type: agentType,
    data: {
      schema_version: 1,
      tools: {
        edit: 'deny',
        external_directory: {
          rules: [
            { pattern: '*', action: 'deny' },
            { pattern: '10', action: 'ask' },
            { pattern: '2', action: 'allow' },
            { pattern: '/shared/*', action: 'allow' },
          ],
        },
      },
    },
  };
  const rules = [
    { pattern: '10', action: 'deny' },
    { pattern: '*', action: 'ask' },
    { pattern: '2', action: 'allow' },
    { pattern: 'git status *', action: 'allow' },
  ];

  test('previews only supported settings, keeping wildcard and integer-like rules in source order', () => {
    const result = reviewPermissionPolicyImport(text);
    expect(result).toStrictEqual({
      status: 'needs-shell',
      source: 'local',
      policy: base,
      rules,
      warnings: [
        expect.stringContaining('configuration fields were ignored'),
        expect.stringContaining('Numeric rule patterns'),
        expect.stringContaining('does not set the unmatched-command action'),
      ],
    });
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(parsePermissionPolicyDocument(JSON.stringify(base))).toStrictEqual({
      status: 'valid',
      source: 'native',
      policy: base,
      warnings: [],
    });
  });

  test.each([
    { kind: 'bash', fallback: 'deny' },
    { kind: 'powershell', fallback: 'ask' },
  ] as const)('uses only the explicitly selected $kind profile and $fallback fallback', shell => {
    const result = reviewPermissionPolicyImport(text, shell);
    expect(result).toStrictEqual({
      status: 'valid',
      source: 'local',
      policy: {
        ...base,
        data: { ...base.data, shell: { [shell.kind]: { fallback: shell.fallback, rules } } },
      },
      warnings: expect.any(Array),
    });
  });

  test.each([
    { kind: 'bash' },
    { fallback: 'deny' },
    { kind: 'bash', fallback: 'allow' },
    { kind: 'cmd', fallback: 'ask' },
  ])('rejects incomplete or invalid shell selections: %j', choice => {
    expect(
      reviewPermissionPolicyImport(
        text,
        choice as Parameters<typeof reviewPermissionPolicyImport>[1]
      )
    ).toEqual({
      status: 'invalid',
      errors: [expect.stringContaining('Choose Bash or PowerShell')],
    });
  });

  test('does not infer a shell or a fallback from an empty map or a wildcard', () => {
    expect(reviewPermissionPolicyImport('{"permission":{"bash":{}}}')).toMatchObject({
      status: 'needs-shell',
      rules: [],
      policy: { data: { schema_version: 1 } },
    });
    expect(reviewPermissionPolicyImport('{"permission":{"bash":{"*":"deny"}}}')).toMatchObject({
      status: 'needs-shell',
      rules: [{ pattern: '*', action: 'deny' }],
    });
  });

  test('does not infer a shell profile from a scalar Bash tool permission', () => {
    expect(reviewPermissionPolicyImport('{"permission":{"bash":"ask"}}')).toStrictEqual({
      status: 'valid',
      source: 'local',
      policy: { type: agentType, data: { schema_version: 1, tools: { bash: 'ask' } } },
      warnings: [],
    });
  });

  test('does not use legacy choices to repair a versioned shell profile', () => {
    const text = agentDocument({ shell: { bash: { rules: [] } } });
    expect(reviewPermissionPolicyImport(text, { kind: 'bash', fallback: 'deny' })).toMatchObject({
      status: 'invalid',
    });
  });

  test.each([
    '{"permission":"deny"}',
    '{"permission":{}}',
    '{"tools":{"edit":false}}',
    '{"permission":{"edit":"allow","*":"deny"}}',
    '{"permission":{"mcp_*":"deny","mcp_tool":"allow"}}',
    '{"permission":{"__proto__":"deny"}}',
    '{"permission":{"external_directory":{"~/Documents/*":"deny"}}}',
    '{"type":"unknown","permission":{"edit":"allow"}}',
    '{"permission":{"bash":{"fallback":"deny","rules":[]}}}',
    '{"permission":{"bash":{"git status *":"approve"}}}',
    '{"permission":{"edit":"deny"},"provider":[{"duplicate":1,"duplicate":2}]}',
  ])('rejects local input it cannot safely interpret: %s', text => {
    expect(reviewPermissionPolicyImport(text)).toMatchObject({ status: 'invalid' });
  });

  test('validates unresolved shell rules through the shared schema', () => {
    const tooManyRules = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`command ${i}`, 'allow'])
    );
    for (const bash of [tooManyRules, { ['x'.repeat(513)]: 'allow' }]) {
      expect(reviewPermissionPolicyImport(JSON.stringify({ permission: { bash } }))).toMatchObject({
        status: 'invalid',
        errors: [expect.stringMatching(/^permission\.bash\.rules/)],
      });
    }
  });

  test('rejects reserved properties in ignored legacy configuration without echoing their values', () => {
    const text = '{"permission":{"edit":"deny"},"provider":[{"__proto__":"secret-value"}]}';
    expect(reviewPermissionPolicyImport(text)).toEqual({
      status: 'invalid',
      errors: [expect.stringMatching(/^Unsupported property at line 1, column \d+\.$/)],
    });
  });

  test('reports oversized legacy shell policies without a native document path', () => {
    const bash = Object.fromEntries(
      Array.from({ length: 90 }, (_, index) => [`command ${index}${'x'.repeat(490)}`, 'deny'])
    );
    const text = JSON.stringify({ permission: { bash } });
    const expected = { status: 'invalid', errors: ['Policy too large.'] };
    expect(reviewPermissionPolicyImport(text)).toEqual(expected);
    expect(reviewPermissionPolicyImport(text, { kind: 'powershell', fallback: 'ask' })).toEqual(
      expected
    );
  });

  test('does not fall back to legacy permissions when the document has a retired policy type', () => {
    const text = JSON.stringify({ ...retiredPolicy, permission: { edit: 'allow' } });
    expect(reviewPermissionPolicyImport(text)).toMatchObject({
      status: 'invalid',
      errors: expect.arrayContaining(['type: Expected an agent_permissions policy document.']),
    });
  });

  test('does not parse a legacy config as a versioned policy document', () => {
    expect(parsePermissionPolicyDocument(text)).toMatchObject({ status: 'invalid' });
  });
});

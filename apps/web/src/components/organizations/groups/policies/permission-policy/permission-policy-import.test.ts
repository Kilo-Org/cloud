import fixtures from '@kilocode/web-shared/lib/organizations/group-policies/permission-policy/v1-fixtures.json';
import {
  parsePermissionPolicyDocument,
  reviewPermissionPolicyImport,
} from './permission-policy-import';

const agentType = 'agent_permissions';
const agentDocument = (data: object) =>
  JSON.stringify({ type: agentType, data: { schema_version: 1, ...data } });

describe.each([parsePermissionPolicyDocument, reviewPermissionPolicyImport])('%p', parse => {
  test.each([
    ['agent_permissions', fixtures.layered.policy.agent_permissions.layers[0]],
    ['agent_permissions', fixtures.layered.policy.agent_permissions.layers[1]],
    ['agent_permissions', fixtures.layered.policy.agent_permissions.layers[2]],
    ['client_access', fixtures.layered.policy.client_access.layers[0]],
    ['client_access', fixtures.layered.policy.client_access.layers[1]],
  ] as const)(
    'round trips a %s producer fixture without altering its policy data',
    (type, data) => {
      const policy = { type, data };
      const text = `{
      // Comments, braces [{, and trailing commas are supported.
      "type": "${type}",
      "data": ${JSON.stringify(data)},
    }`;
      expect(parse(text, type)).toStrictEqual({ status: 'valid', policy, warnings: [] });
    }
  );

  test.each(['{}', '{"type":"agent_permissions","data":', '{"bad":"\\q"}', '[]', 'null'])(
    'rejects non-policy or malformed input: %s',
    text => {
      expect(parse(text, agentType)).toMatchObject({
        status: 'invalid',
        errors: [expect.any(String)],
      });
    }
  );

  test('rejects decoded duplicates and locates them without repeating the property', () => {
    const text = `{
      "type": "agent_permissions",
      "data": {"schema_version": 1, "secret-name": 0, "secret-\\u006eame": 1}
    }`;
    expect(parse(text, agentType)).toEqual({
      status: 'invalid',
      errors: [expect.stringMatching(/^Duplicate property at line 3, column \d+\.$/)],
    });
  });

  test('rejects excessive raw UTF-8 bytes and nesting even in ignored sections', () => {
    expect(parse(`/* ${'\u00e9'.repeat(70_000)} */ {}`, agentType)).toEqual({
      status: 'invalid',
      errors: [expect.stringContaining('128 KiB')],
    });
    expect(parse(`{"ignored":${'['.repeat(1_000)}0${']'.repeat(1_000)}}`, agentType)).toEqual({
      status: 'invalid',
      errors: [expect.stringContaining('nested too deeply')],
    });
  });

  test('enforces the shared serialized-size limit as well as the raw input limit', () => {
    const rules = Array.from({ length: 90 }, (_, index) => ({
      pattern: `${index}${'x'.repeat(499)}`,
      action: 'allow',
    }));
    expect(
      parse(agentDocument({ shell: { bash: { fallback: 'ask', rules } } }), agentType)
    ).toEqual({
      status: 'invalid',
      errors: ['data: Policy too large.'],
    });
  });

  test('keeps an omitted shell map distinct from an explicit empty shell map', () => {
    expect(parse(agentDocument({}), agentType)).toStrictEqual({
      status: 'valid',
      policy: { type: agentType, data: { schema_version: 1 } },
      warnings: [],
    });
    expect(parse(agentDocument({ shell: {} }), agentType)).toStrictEqual({
      status: 'valid',
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
    expect(parse(agentDocument({ shell }), agentType)).toMatchObject({ status: 'invalid' });
  });

  test('rejects the wrong policy type and a member envelope', () => {
    expect(parse(agentDocument({}), 'client_access')).toEqual({
      status: 'invalid',
      errors: ['Expected a client_access policy document.'],
    });
    expect(parse(JSON.stringify(fixtures.layered), agentType)).toMatchObject({ status: 'invalid' });
  });

  test('rejects a future policy version and strict client access violations', () => {
    expect(parse(agentDocument({ schema_version: 2 }), agentType)).toMatchObject({
      status: 'invalid',
    });
    for (const data of [
      { mode: 'allowlist', clients: [], unknown_clients: 'allow' },
      { mode: 'allowlist', clients: [{ feature: 'cli', min_version: '1.2' }] },
      { mode: 'allowlist', clients: [{ feature: 'cli' }, { feature: 'cli' }] },
      { mode: 'blocklist', clients: [{ feature: 'cli', min_version: '1.2.3' }] },
    ]) {
      expect(
        parse(
          JSON.stringify({ type: 'client_access', data: { schema_version: 1, ...data } }),
          'client_access'
        )
      ).toMatchObject({ status: 'invalid' });
    }
  });

  test('formats validation issues without displaying supplied keys, patterns, or values', () => {
    const text = agentDocument({
      'secret-field': 'secret-value',
      tools: { 'secret-tool': { rules: [{ pattern: 'secret-pattern', action: 'secret-action' }] } },
    });
    const result = parse(text, agentType);
    expect(result).toMatchObject({ status: 'invalid' });
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(JSON.stringify(result)).toContain('data.tools[tool]');
  });

  test('rejects a tool key the shared schema would silently remove', () => {
    const text =
      '{"type":"agent_permissions","data":{"schema_version":1,"tools":{"__proto__":"deny"}}}';
    expect(parse(text, agentType)).toEqual({
      status: 'invalid',
      errors: ['data.tools: Contains an unsupported tool key.'],
    });
  });
});

describe('legacy Kilo configuration', () => {
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
    const result = reviewPermissionPolicyImport(text, agentType);
    expect(result).toStrictEqual({
      status: 'needs-shell',
      policy: base,
      rules,
      warnings: [
        expect.stringContaining('configuration fields were ignored'),
        expect.stringContaining('Numeric rule patterns'),
        expect.stringContaining('does not set the unmatched-command action'),
      ],
    });
    expect(JSON.stringify(result)).not.toContain('secret-');
    expect(parsePermissionPolicyDocument(JSON.stringify(base), agentType)).toStrictEqual({
      status: 'valid',
      policy: base,
      warnings: [],
    });
  });

  test.each([
    { kind: 'bash', fallback: 'deny' },
    { kind: 'powershell', fallback: 'ask' },
  ] as const)('uses only the explicitly selected $kind profile and $fallback fallback', shell => {
    const result = reviewPermissionPolicyImport(text, agentType, shell);
    expect(result).toStrictEqual({
      status: 'valid',
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
        agentType,
        choice as Parameters<typeof reviewPermissionPolicyImport>[2]
      )
    ).toEqual({
      status: 'invalid',
      errors: [expect.stringContaining('Choose Bash or PowerShell')],
    });
  });

  test('does not infer a shell or a fallback from an empty map or a wildcard', () => {
    expect(reviewPermissionPolicyImport('{"permission":{"bash":{}}}', agentType)).toMatchObject({
      status: 'needs-shell',
      rules: [],
      policy: { data: { schema_version: 1 } },
    });
    expect(
      reviewPermissionPolicyImport('{"permission":{"bash":{"*":"deny"}}}', agentType)
    ).toMatchObject({
      status: 'needs-shell',
      rules: [{ pattern: '*', action: 'deny' }],
    });
  });

  test('does not infer a shell profile from a scalar Bash tool permission', () => {
    expect(reviewPermissionPolicyImport('{"permission":{"bash":"ask"}}', agentType)).toStrictEqual({
      status: 'valid',
      policy: { type: agentType, data: { schema_version: 1, tools: { bash: 'ask' } } },
      warnings: [],
    });
  });

  test('does not use legacy choices to repair a versioned shell profile', () => {
    const text = agentDocument({ shell: { bash: { rules: [] } } });
    expect(
      reviewPermissionPolicyImport(text, agentType, { kind: 'bash', fallback: 'deny' })
    ).toMatchObject({ status: 'invalid' });
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
    expect(reviewPermissionPolicyImport(text, agentType)).toMatchObject({ status: 'invalid' });
  });

  test('validates unresolved shell rules through the shared schema', () => {
    const tooManyRules = Object.fromEntries(
      Array.from({ length: 101 }, (_, i) => [`command ${i}`, 'allow'])
    );
    for (const bash of [tooManyRules, { ['x'.repeat(513)]: 'allow' }]) {
      expect(
        reviewPermissionPolicyImport(JSON.stringify({ permission: { bash } }), agentType)
      ).toMatchObject({
        status: 'invalid',
        errors: [expect.stringMatching(/^permission\.bash\.rules/)],
      });
    }
  });

  test('requires the matching import mode instead of silently converting client or advanced policy', () => {
    expect(reviewPermissionPolicyImport(text, 'client_access')).toMatchObject({
      status: 'invalid',
    });
    expect(parsePermissionPolicyDocument(text, agentType)).toMatchObject({ status: 'invalid' });
  });
});

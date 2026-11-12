import {
  evaluateMcpConnect,
  normalizeGuardrailConfig,
  normalizeMcpConnectTarget,
  resolveGuardrailsSettings,
  type AllowedMcpServer,
} from './guardrails-policy';

const remote = { kind: 'remote' as const, url: 'https://mcp.example.com/mcp' };
const pkg = {
  kind: 'package' as const,
  ecosystem: 'npm' as const,
  identifier: '@acme/server',
};

function allowed(
  config: AllowedMcpServer['config'],
  identityKey: string
): Pick<AllowedMcpServer, 'identityKey' | 'config'> {
  return { identityKey, config };
}

describe('resolveGuardrailsSettings', () => {
  const organization = (settings: object) => ({ id: 'org-1', settings }) as never;

  it('turns everything off for organizations without AI Guardrails', () => {
    expect(
      resolveGuardrailsSettings(
        organization({
          guardrails: {
            mcp: { enforcement: 'enforce' },
            skill: { enabled: true, scan_before_use: true },
          },
        })
      )
    ).toEqual({
      inputScan: { enabled: false, scanToolResults: false },
      mcpEnforcement: 'off',
      skill: { enabled: false, scanBeforeUse: false },
    });
  });

  it('defaults to off with scanning before skill use', () => {
    expect(resolveGuardrailsSettings(organization({ kilo_encrypt: true }))).toEqual({
      inputScan: { enabled: false, scanToolResults: false },
      mcpEnforcement: 'off',
      skill: { enabled: false, scanBeforeUse: true },
    });
  });

  it('reports saved settings', () => {
    expect(
      resolveGuardrailsSettings(
        organization({
          kilo_encrypt: true,
          guardrails: {
            mcp: { enforcement: 'shadow' },
            skill: { enabled: true, scan_before_use: false },
          },
          enkrypt: {
            input_guardrail: { enabled: true, scan_tool_results: false },
          },
        })
      )
    ).toEqual({
      inputScan: { enabled: true, scanToolResults: false },
      mcpEnforcement: 'shadow',
      skill: { enabled: true, scanBeforeUse: false },
    });
  });
});

describe('normalizeMcpConnectTarget', () => {
  it('normalizes to the same identity key the allow list uses', () => {
    expect(
      normalizeMcpConnectTarget({
        kind: 'remote',
        url: 'https://MCP.example.com/mcp/?token=1',
      })
    ).toEqual({
      target: remote,
      identityKey: 'remote:https://mcp.example.com/mcp',
    });
    expect(
      normalizeMcpConnectTarget({
        kind: 'package',
        ecosystem: 'pypi',
        identifier: 'My_Server',
      })?.identityKey
    ).toBe('pypi:my-server');
  });

  it.each([
    { kind: 'remote' as const, url: 'http://mcp.example.com/mcp' },
    { kind: 'remote' as const, url: 'https://user:secret@mcp.example.com/mcp' },
    {
      kind: 'remote' as const,
      url: `https://mcp.example.com/${'a'.repeat(600)}`,
    },
    {
      kind: 'package' as const,
      ecosystem: 'npm' as const,
      identifier: 'not a package',
    },
  ])('rejects a target that can never be allowlisted: %j', input => {
    expect(normalizeMcpConnectTarget(input)).toBeNull();
  });
});

describe('evaluateMcpConnect', () => {
  const remoteTarget = normalizeMcpConnectTarget(remote);
  const packageTarget = normalizeMcpConnectTarget(pkg);
  const allowedServers = [
    allowed({ kind: 'remote', url: remote.url }, 'remote:https://mcp.example.com/mcp'),
    allowed(
      {
        kind: 'package',
        ecosystem: 'npm',
        identifier: '@acme/server',
        version_spec: '^2.0.0 || >=3.0.3',
      },
      'npm:@acme/server'
    ),
  ];

  const evaluate = (
    params: Omit<Parameters<typeof evaluateMcpConnect>[0], 'mcpEnforcement'>,
    mcpEnforcement: 'shadow' | 'enforce' = 'enforce'
  ) => evaluateMcpConnect({ ...params, mcpEnforcement });

  it('allows a server on the list', () => {
    expect(evaluate({ allowedServers, target: remoteTarget })).toEqual({
      decision: 'allowed',
    });
  });

  it('denies a server that is not on the list', () => {
    expect(evaluate({ allowedServers: [], target: remoteTarget })).toEqual({
      decision: 'denied',
      reason: 'not_allowed',
    });
  });

  it('denies a target that can never be allowlisted', () => {
    expect(evaluate({ allowedServers, target: null })).toEqual({
      decision: 'denied',
      reason: 'unsupported_target',
    });
  });

  it('asks the client to check the range when it reports no version', () => {
    expect(evaluate({ allowedServers, target: packageTarget })).toEqual({
      decision: 'allowed',
      versionCheck: 'client',
      versionSpec: '^2.0.0 || >=3.0.3',
    });
  });

  it('treats a blank reported version as absent', () => {
    expect(evaluate({ allowedServers, target: packageTarget, version: '   ' })).toEqual({
      decision: 'allowed',
      versionCheck: 'client',
      versionSpec: '^2.0.0 || >=3.0.3',
    });
  });

  it('checks the resolved version against the allowed range', () => {
    expect(
      evaluate({
        allowedServers,
        target: packageTarget,
        version: '2.0.1',
      })
    ).toEqual({ decision: 'allowed', versionCheck: 'server' });
    expect(
      evaluate({
        allowedServers,
        target: packageTarget,
        version: '3.1.0',
      })
    ).toEqual({ decision: 'allowed', versionCheck: 'server' });
    expect(
      evaluate({
        allowedServers,
        target: packageTarget,
        version: '1.9.0',
      })
    ).toEqual({
      decision: 'denied',
      reason: 'below_min_version',
      versionReason: 'version_not_allowed',
      versionCheck: 'server',
    });
  });

  it('treats a prerelease as lower than its release', () => {
    expect(
      evaluate({
        allowedServers,
        target: packageTarget,
        version: '2.0.0rc1',
      })
    ).toEqual({
      decision: 'denied',
      reason: 'below_min_version',
      versionReason: 'version_not_allowed',
      versionCheck: 'server',
    });
  });

  it('denies a tag, which is not a resolved version', () => {
    expect(
      evaluate({
        allowedServers,
        target: packageTarget,
        version: 'latest',
      })
    ).toEqual({
      decision: 'denied',
      reason: 'below_min_version',
      versionReason: 'invalid_version',
      versionCheck: 'server',
    });
  });

  it('distinguishes an invalid stored policy from an invalid client version', () => {
    const invalidPolicy = [
      allowed(
        {
          kind: 'package',
          ecosystem: 'npm',
          identifier: '@acme/server',
          version_spec: 'not a range',
        },
        'npm:@acme/server'
      ),
    ];
    expect(
      evaluate({ allowedServers: invalidPolicy, target: packageTarget, version: '2.0.0' })
    ).toEqual({
      decision: 'denied',
      reason: 'below_min_version',
      versionReason: 'invalid_policy',
      versionCheck: 'server',
    });
    expect(evaluate({ allowedServers: invalidPolicy, target: packageTarget })).toEqual({
      decision: 'denied',
      reason: 'below_min_version',
      versionReason: 'invalid_policy',
      versionCheck: 'server',
    });
  });

  it('treats a legacy 0.0.0 minimum as any version', () => {
    const legacyAny = [
      allowed(
        {
          kind: 'package',
          ecosystem: 'npm',
          identifier: '@acme/server',
          version_spec: null,
          min_version: '0.0.0',
        },
        'npm:@acme/server'
      ),
    ];
    expect(
      evaluate({ allowedServers: legacyAny, target: packageTarget, version: '0.0.1' })
    ).toEqual({ decision: 'allowed' });
    expect(evaluate({ allowedServers: legacyAny, target: packageTarget })).toEqual({
      decision: 'allowed',
    });
    expect(
      evaluate({ allowedServers: legacyAny, target: packageTarget, version: '0.0.0' })
    ).toEqual({ decision: 'allowed' });
  });

  it('fails closed when a legacy minimum cannot be converted', () => {
    const legacy = [
      allowed(
        {
          kind: 'package',
          ecosystem: 'npm',
          identifier: '@acme/server',
          version_spec: null,
          min_version: 'latest',
        },
        'npm:@acme/server'
      ),
    ];
    const denied = {
      decision: 'denied',
      reason: 'below_min_version',
      versionReason: 'invalid_policy',
      versionCheck: 'server',
    };
    expect(evaluate({ allowedServers: legacy, target: packageTarget })).toEqual(denied);
    expect(evaluate({ allowedServers: legacy, target: packageTarget, version: '1.0.0' })).toEqual(
      denied
    );
  });

  it('enforces a legacy min_version when no range is stored', () => {
    const legacy = [
      allowed(
        {
          kind: 'package',
          ecosystem: 'npm',
          identifier: '@acme/server',
          version_spec: null,
          min_version: '2.0.0',
        },
        'npm:@acme/server'
      ),
    ];
    expect(evaluate({ allowedServers: legacy, target: packageTarget, version: '1.9.0' })).toEqual({
      decision: 'denied',
      reason: 'below_min_version',
      versionReason: 'version_not_allowed',
      versionCheck: 'server',
    });
    expect(evaluate({ allowedServers: legacy, target: packageTarget, version: '2.0.1' })).toEqual({
      decision: 'allowed',
      versionCheck: 'server',
    });
  });

  it('allows any resolved version when the server has no range', () => {
    const anyVersion = [
      allowed(
        {
          kind: 'package',
          ecosystem: 'npm',
          identifier: '@acme/server',
          version_spec: null,
        },
        'npm:@acme/server'
      ),
    ];
    expect(
      evaluate({ allowedServers: anyVersion, target: packageTarget, version: '0.0.1' })
    ).toEqual({ decision: 'allowed' });
  });

  it('does not ask the client to enforce a range while auditing', () => {
    expect(evaluate({ allowedServers, target: packageTarget }, 'shadow')).toEqual({
      decision: 'allowed',
    });
  });
});

describe('normalizeGuardrailConfig', () => {
  const packageConfig = (minVersion: string | null) => ({
    kind: 'package' as const,
    ecosystem: 'npm' as const,
    identifier: '@acme/server',
    version_spec: null,
    min_version: minVersion,
  });

  it('keeps a 0.0.0 legacy minimum as an unrestricted policy', () => {
    expect(normalizeGuardrailConfig(packageConfig('0.0.0'))).toMatchObject({
      version_spec: null,
      min_version: '0.0.0',
    });
  });

  it('converts a usable legacy minimum to its range', () => {
    expect(normalizeGuardrailConfig(packageConfig('1.2.3'))).toMatchObject({
      version_spec: '>=1.2.3',
      min_version: '1.2.3',
    });
  });

  it('marks an unusable legacy minimum as invalid without exposing a sentinel', () => {
    expect(normalizeGuardrailConfig(packageConfig('latest'))).toMatchObject({
      version_spec: null,
      version_spec_invalid: true,
      min_version: 'latest',
    });
  });

  it('flags a stored range that is not valid', () => {
    expect(
      normalizeGuardrailConfig({
        kind: 'package',
        ecosystem: 'npm',
        identifier: '@acme/server',
        version_spec: 'not a range',
      })
    ).toMatchObject({
      version_spec: 'not a range',
      version_spec_invalid: true,
    });
  });
});

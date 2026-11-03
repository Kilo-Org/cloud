import {
  evaluateMcpConnect,
  isVersionAtLeast,
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

describe('isVersionAtLeast', () => {
  it.each([
    ['1.2.3', '1.2.3', true],
    ['1.10.0', '1.9.9', true],
    ['2', '1.9', true],
    ['1.2', '1.2.0', true],
    ['v1.2.3', '1.2.3', true],
    ['1.2.0rc1', '1.2.0', true],
    ['1.2.2', '1.2.3', false],
    ['0.9.9', '1.0', false],
    ['latest', '1.0', null],
  ])('%s against %s', (version, minimum, expected) => {
    expect(isVersionAtLeast(version, minimum)).toBe(expected);
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
        min_version: '2.0.0',
      },
      'npm:@acme/server'
    ),
  ];

  it('allows a server on the list', () => {
    expect(evaluateMcpConnect({ allowedServers, target: remoteTarget })).toEqual({
      decision: 'allowed',
    });
  });

  it('denies a server that is not on the list', () => {
    expect(evaluateMcpConnect({ allowedServers: [], target: remoteTarget })).toEqual({
      decision: 'denied',
      reason: 'not_allowed',
    });
  });

  it('denies a target that can never be allowlisted', () => {
    expect(evaluateMcpConnect({ allowedServers, target: null })).toEqual({
      decision: 'denied',
      reason: 'unsupported_target',
    });
  });

  it('checks the minimum version only when the client reports one', () => {
    expect(evaluateMcpConnect({ allowedServers, target: packageTarget })).toEqual({
      decision: 'allowed',
    });
    expect(
      evaluateMcpConnect({
        allowedServers,
        target: packageTarget,
        version: '2.0.1',
      })
    ).toEqual({ decision: 'allowed' });
    expect(
      evaluateMcpConnect({
        allowedServers,
        target: packageTarget,
        version: '1.9.0',
      })
    ).toEqual({ decision: 'denied', reason: 'below_min_version' });
    expect(
      evaluateMcpConnect({
        allowedServers,
        target: packageTarget,
        version: 'latest',
      })
    ).toEqual({ decision: 'denied', reason: 'below_min_version' });
  });
});

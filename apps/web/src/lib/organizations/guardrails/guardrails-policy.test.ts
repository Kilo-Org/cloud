import { organization_group_memberships, organization_groups } from '@kilocode/db/schema';
import type {
  EnkryptOutputGuardrailSettings,
  OrganizationSettings,
} from '@kilocode/db/schema-types';
import { createEmptyEnkryptOutputDetectors } from '@kilocode/web-shared/lib/ai-gateway/enkrypt-guardrail/detectors';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  evaluateMcpConnect,
  getOrganizationGuardrailsPolicy,
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
      outputScan: { enabled: false, buffersResponses: false },
      mcpEnforcement: 'off',
      skill: { enabled: false, scanBeforeUse: false },
    });
  });

  it('defaults to off with scanning before skill use', () => {
    expect(resolveGuardrailsSettings(organization({ kilo_encrypt: true }))).toEqual({
      inputScan: { enabled: false, scanToolResults: false },
      outputScan: { enabled: false, buffersResponses: false },
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
            output_guardrail: {
              enabled: true,
              detectors: {
                ...createEmptyEnkryptOutputDetectors(),
                pii: { enabled: true, action: 'log', entities: ['secrets'] },
              },
            },
          },
        })
      )
    ).toEqual({
      inputScan: { enabled: true, scanToolResults: true },
      outputScan: { enabled: true, buffersResponses: false },
      mcpEnforcement: 'shadow',
      skill: { enabled: true, scanBeforeUse: false },
    });
  });

  it('reports that a blocking response detector buffers responses', () => {
    expect(
      resolveGuardrailsSettings(
        organization({
          kilo_encrypt: true,
          enkrypt: {
            output_guardrail: {
              enabled: true,
              detectors: {
                ...createEmptyEnkryptOutputDetectors(),
                toxicity: { enabled: true, action: 'block' },
              },
            },
          },
        })
      ).outputScan
    ).toEqual({ enabled: true, buffersResponses: true });
  });
});

describe('getOrganizationGuardrailsPolicy', () => {
  const outputGuardrail: EnkryptOutputGuardrailSettings = {
    enabled: true,
    detectors: {
      ...createEmptyEnkryptOutputDetectors(),
      toxicity: { enabled: true, action: 'block' },
    },
  };

  async function scopedOrganization(enabled: boolean) {
    const owner = await insertTestUser();
    const inGroup = await insertTestUser();
    const outsideGroup = await insertTestUser();
    const organization = await createTestOrganization(
      'Group Scoped Guardrails',
      owner.id,
      0,
      { kilo_encrypt: true },
      false
    );
    await addUserToOrganization(organization.id, inGroup.id, 'member');
    await addUserToOrganization(organization.id, outsideGroup.id, 'member');
    const [group] = await db
      .insert(organization_groups)
      .values({ organization_id: organization.id, name: 'Engineering' })
      .returning();
    const [otherGroup] = await db
      .insert(organization_groups)
      .values({ organization_id: organization.id, name: 'Support' })
      .returning();
    await db.insert(organization_group_memberships).values([
      { organization_id: organization.id, group_id: group.id, kilo_user_id: inGroup.id },
      { organization_id: organization.id, group_id: otherGroup.id, kilo_user_id: outsideGroup.id },
    ]);
    const settings: OrganizationSettings = {
      kilo_encrypt: true,
      enkrypt: {
        input_guardrail: { enabled, group_id: group.id },
        output_guardrail: outputGuardrail,
      },
    };
    return { organization: { id: organization.id, settings }, inGroup, outsideGroup };
  }

  it('scans input only for members of the group the input guardrail is limited to', async () => {
    const { organization, inGroup, outsideGroup } = await scopedOrganization(true);

    await expect(getOrganizationGuardrailsPolicy(organization, inGroup.id)).resolves.toMatchObject({
      inputScan: { enabled: true, scanToolResults: true },
      outputScan: { enabled: true, buffersResponses: true },
    });
    await expect(
      getOrganizationGuardrailsPolicy(organization, outsideGroup.id)
    ).resolves.toMatchObject({
      inputScan: { enabled: false, scanToolResults: false },
      outputScan: { enabled: true, buffersResponses: true },
    });
  });

  it('scans input for every member when the input guardrail is not limited to a group', async () => {
    const { organization, outsideGroup } = await scopedOrganization(true);
    const unscoped = {
      ...organization,
      settings: {
        ...organization.settings,
        enkrypt: {
          ...organization.settings.enkrypt,
          input_guardrail: { enabled: true, group_id: null },
        },
      },
    };

    await expect(getOrganizationGuardrailsPolicy(unscoped, outsideGroup.id)).resolves.toMatchObject(
      { inputScan: { enabled: true, scanToolResults: true } }
    );
  });

  it('keeps input scanning off for group members while the input guardrail is disabled', async () => {
    const { organization, inGroup } = await scopedOrganization(false);

    await expect(getOrganizationGuardrailsPolicy(organization, inGroup.id)).resolves.toMatchObject({
      inputScan: { enabled: false, scanToolResults: false },
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

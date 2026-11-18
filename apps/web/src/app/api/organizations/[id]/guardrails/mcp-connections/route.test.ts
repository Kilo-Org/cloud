import { describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { organization_guardrails, organization_mcp_connect_events } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { MAX_MCP_CONNECTIONS_PER_REQUEST, POST } from './route';

jest.mock('@/lib/organizations/organization-auth');

const mockedGetAuthorizedOrgContext = jest.mocked(getAuthorizedOrgContext);

const remoteTarget = { kind: 'remote', url: 'https://mcp.example.com/mcp' };
const packageTarget = {
  kind: 'package',
  ecosystem: 'npm',
  identifier: '@acme/server',
};

async function setup(enforcement: 'off' | 'shadow' | 'enforce', kiloEncrypt = true) {
  const user = await insertTestUser();
  const organization = await createTestOrganization('MCP connections', user.id, 0, {
    kilo_encrypt: kiloEncrypt,
    guardrails: { mcp: { enforcement } },
  });
  await db.insert(organization_guardrails).values({
    organization_id: organization.id,
    type: 'mcp',
    identity_key: 'npm:@acme/server',
    name: 'Acme',
    config: {
      kind: 'package',
      ecosystem: 'npm',
      identifier: '@acme/server',
      version_spec: '^2.0.0',
    },
    source: { registry: 'custom', id: null },
  });
  mockedGetAuthorizedOrgContext.mockResolvedValue({
    success: true,
    data: {
      organization: await getOrganizationById(organization.id),
      user: { id: user.id },
    },
  } as never);
  return { organization, user };
}

function post(organizationId: string, body: unknown) {
  return POST(
    new NextRequest('http://localhost:3000', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: organizationId }) }
  );
}

describe('POST /api/organizations/[id]/guardrails/mcp-connections', () => {
  afterEach(cleanupDbForTest);

  test('returns the auth failure unchanged and records nothing', async () => {
    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: false,
      nextResponse: NextResponse.json({ error: 'Organization not found' }, { status: 404 }),
    });

    const response = await post('org-1', {
      client: 'cli',
      connections: [{ target: remoteTarget }],
    });

    expect(response.status).toBe(404);
    expect(await db.select().from(organization_mcp_connect_events)).toHaveLength(0);
  });

  test.each([
    ['invalid JSON', 'not json'],
    ['an unknown client', { client: 'toaster', connections: [{ target: remoteTarget }] }],
    ['no connections', { client: 'cli', connections: [] }],
    [
      'too many connections',
      {
        client: 'cli',
        connections: Array.from({ length: MAX_MCP_CONNECTIONS_PER_REQUEST + 1 }, () => ({
          target: remoteTarget,
        })),
      },
    ],
    ['an unknown target kind', { client: 'cli', connections: [{ target: { kind: 'stdio' } }] }],
  ])('rejects %s', async (_name, body) => {
    const { organization } = await setup('enforce');

    const response = await post(organization.id, body);

    expect(response.status).toBe(400);
    expect(await db.select().from(organization_mcp_connect_events)).toHaveLength(0);
  });

  test('records and blocks denied connects when the allow list is enforced', async () => {
    const { organization, user } = await setup('enforce');

    const response = await post(organization.id, {
      client: 'vscode',
      connections: [
        { target: packageTarget, serverName: '  Acme  ', version: '2.1.0' },
        { target: remoteTarget, serverName: 'Unknown' },
        { target: packageTarget, version: '1.0.0' },
      ],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enforcement: 'enforce',
      results: [
        {
          decision: 'allowed',
          identityKey: 'npm:@acme/server',
          action: 'allow',
          recorded: true,
          versionCheck: 'server',
        },
        {
          decision: 'denied',
          reason: 'not_allowed',
          identityKey: 'remote:https://mcp.example.com/mcp',
          action: 'block',
          recorded: true,
        },
        {
          decision: 'denied',
          reason: 'below_min_version',
          versionReason: 'version_not_allowed',
          identityKey: 'npm:@acme/server',
          versionCheck: 'server',
          action: 'block',
          recorded: true,
        },
      ],
    });
    const events = await db.select().from(organization_mcp_connect_events);
    expect(
      events
        .map(event => [event.decision, event.identity_key, event.server_name])
        .sort((a, b) => `${a}`.localeCompare(`${b}`))
    ).toEqual([
      ['allowed', 'npm:@acme/server', 'Acme'],
      ['denied', 'npm:@acme/server', null],
      ['denied', 'remote:https://mcp.example.com/mcp', 'Unknown'],
    ]);
    expect(events.every(event => event.kilo_user_id === user.id)).toBe(true);
    expect(events.every(event => event.organization_id === organization.id)).toBe(true);
    expect(events.every(event => event.client === 'vscode')).toBe(true);
  });

  test('asks the client to check the range when no version is reported', async () => {
    const { organization } = await setup('enforce');

    const response = await post(organization.id, {
      client: 'cli',
      connections: [{ target: packageTarget }],
    });

    expect((await response.json()).results).toEqual([
      {
        decision: 'allowed',
        versionCheck: 'client',
        versionSpec: '^2.0.0',
        identityKey: 'npm:@acme/server',
        action: 'allow',
        recorded: true,
      },
    ]);
  });

  test('does not ask the client to check a range while auditing', async () => {
    const { organization } = await setup('shadow');

    const response = await post(organization.id, {
      client: 'cli',
      connections: [{ target: packageTarget }],
    });

    expect((await response.json()).results).toEqual([
      {
        decision: 'allowed',
        identityKey: 'npm:@acme/server',
        action: 'allow',
        recorded: true,
      },
    ]);
  });

  test('denies a tag when a resolved version is required', async () => {
    const { organization } = await setup('enforce');

    const response = await post(organization.id, {
      client: 'cli',
      connections: [{ target: packageTarget, version: 'latest' }],
    });

    expect((await response.json()).results).toEqual([
      {
        decision: 'denied',
        reason: 'below_min_version',
        versionReason: 'invalid_version',
        versionCheck: 'server',
        identityKey: 'npm:@acme/server',
        action: 'block',
        recorded: true,
      },
    ]);
  });

  test('records a violation but does not block it in audit mode', async () => {
    const { organization } = await setup('shadow');

    const response = await post(organization.id, {
      client: 'cli',
      connections: [{ target: remoteTarget }],
    });

    expect((await response.json()).results).toEqual([
      {
        decision: 'denied',
        reason: 'not_allowed',
        identityKey: 'remote:https://mcp.example.com/mcp',
        action: 'allow',
        recorded: true,
      },
    ]);
    const events = await db.select().from(organization_mcp_connect_events);
    expect(events.map(event => event.decision)).toEqual(['denied']);
  });

  test.each([
    ['MCP guardrails are off', 'off' as const, true],
    ['AI Guardrails is not granted', 'enforce' as const, false],
  ])('allows and records nothing when %s', async (_name, enforcement, kiloEncrypt) => {
    const { organization } = await setup(enforcement, kiloEncrypt);

    const response = await post(organization.id, {
      client: 'cli',
      connections: [{ target: remoteTarget }],
    });

    expect(await response.json()).toEqual({
      enforcement: 'off',
      results: [
        {
          decision: 'allowed',
          identityKey: null,
          action: 'allow',
          recorded: false,
        },
      ],
    });
    expect(await db.select().from(organization_mcp_connect_events)).toHaveLength(0);
  });

  test('denies a target that cannot be allowlisted without recording it', async () => {
    const { organization } = await setup('enforce');

    const response = await post(organization.id, {
      client: 'cli',
      connections: [
        {
          target: {
            kind: 'remote',
            url: 'https://user:secret@mcp.example.com/mcp',
          },
        },
        { target: { kind: 'remote', url: 'http://mcp.example.com/mcp' } },
      ],
    });

    expect((await response.json()).results).toEqual([
      {
        decision: 'denied',
        reason: 'unsupported_target',
        identityKey: null,
        action: 'block',
        recorded: false,
      },
      {
        decision: 'denied',
        reason: 'unsupported_target',
        identityKey: null,
        action: 'block',
        recorded: false,
      },
    ]);
    expect(await db.select().from(organization_mcp_connect_events)).toHaveLength(0);
  });
});

import { describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { organization_guardrails } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { GET } from './route';

jest.mock('@/lib/organizations/organization-auth');

const mockedGetAuthorizedOrgContext = jest.mocked(getAuthorizedOrgContext);

async function request(organizationId: string) {
  const organization = await getOrganizationById(organizationId);
  mockedGetAuthorizedOrgContext.mockResolvedValue({
    success: true,
    data: { organization, user: { id: 'user-1' } },
  } as never);
  return GET(new NextRequest('http://localhost:3000'), {
    params: Promise.resolve({ id: organizationId }),
  });
}

async function addMcp(
  organizationId: string,
  name: string,
  identifier: string,
  status: 'enabled' | 'disabled' = 'enabled'
) {
  await db.insert(organization_guardrails).values({
    organization_id: organizationId,
    type: 'mcp',
    identity_key: `npm:${identifier}`,
    name,
    status,
    config: {
      kind: 'package',
      ecosystem: 'npm',
      identifier,
      min_version: '1.2.0',
    },
    source: { registry: 'custom', id: null },
  });
}

describe('GET /api/organizations/[id]/guardrails', () => {
  afterEach(cleanupDbForTest);

  test('returns the auth failure unchanged', async () => {
    const failure = NextResponse.json({ error: 'Organization not found' }, { status: 404 });
    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: false,
      nextResponse: failure,
    });

    const response = await GET(new NextRequest('http://localhost:3000'), {
      params: Promise.resolve({ id: 'org-1' }),
    });

    expect(response.status).toBe(404);
  });

  test('returns everything off, without the allow list, when AI Guardrails is not granted', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('No guardrails', user.id, 0, {
      guardrails: {
        mcp: { enforcement: 'enforce' },
        skill: { enabled: true, scan_before_use: true },
      },
    });
    await addMcp(organization.id, 'Acme', '@acme/server');

    const response = await request(organization.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      inputScan: { enabled: false, scanToolResults: false },
      mcp: { enforcement: 'off', allowedServers: [] },
      skill: { enabled: false, scanBeforeUse: false },
    });
  });

  test('returns the enabled MCP servers with the saved guardrail settings', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Guardrails', user.id, 0, {
      kilo_encrypt: true,
      guardrails: {
        mcp: { enforcement: 'enforce' },
        skill: { enabled: true, scan_before_use: false },
      },
      enkrypt: {
        input_guardrail: { enabled: true, scan_tool_results: false },
      },
    });
    await addMcp(organization.id, 'Zeta', '@acme/zeta');
    await addMcp(organization.id, 'Acme', '@acme/server');
    await addMcp(organization.id, 'Paused', '@acme/paused', 'disabled');

    const response = await request(organization.id);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      inputScan: { enabled: true, scanToolResults: false },
      mcp: {
        enforcement: 'enforce',
        allowedServers: [
          {
            identityKey: 'npm:@acme/server',
            name: 'Acme',
            description: null,
            config: {
              kind: 'package',
              ecosystem: 'npm',
              identifier: '@acme/server',
              min_version: '1.2.0',
            },
          },
          {
            identityKey: 'npm:@acme/zeta',
            name: 'Zeta',
            description: null,
            config: {
              kind: 'package',
              ecosystem: 'npm',
              identifier: '@acme/zeta',
              min_version: '1.2.0',
            },
          },
        ],
      },
      skill: { enabled: true, scanBeforeUse: false },
    });
  });

  test('omits the allow list while MCP guardrails are off', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('MCP off', user.id, 0, {
      kilo_encrypt: true,
    });
    await addMcp(organization.id, 'Acme', '@acme/server');

    const body = await (await request(organization.id)).json();

    expect(body.mcp).toEqual({ enforcement: 'off', allowedServers: [] });
    expect(body.skill).toEqual({ enabled: false, scanBeforeUse: true });
  });
});

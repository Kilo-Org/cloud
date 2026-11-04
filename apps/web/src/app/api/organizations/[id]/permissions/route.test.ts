import { describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { organization_permission_rules } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { PermissionPolicyResponseSchema } from '@/lib/organizations/permissions/types';
import { GET } from './route';

jest.mock('@/lib/organizations/organization-auth');

const mockedGetAuthorizedOrgContext = jest.mocked(getAuthorizedOrgContext);

async function setup(
  enforcement: 'off' | 'shadow' | 'enforce',
  { kiloEncrypt = true, defaultEffect = 'ask' as const } = {}
) {
  const owner = await insertTestUser();
  const member = await insertTestUser();
  const organization = await createTestOrganization('Permissions', owner.id, 0, {
    kilo_encrypt: kiloEncrypt,
    guardrails: { permissions: { enforcement, default_effect: defaultEffect } },
  });
  await db.insert(organization_permission_rules).values(
    [
      { permission: 'bash', pattern: 'git *', tier: 'broad_allow' as const },
      { permission: 'bash', pattern: '*>*', tier: 'final_deny' as const },
      { permission: 'bash', pattern: 'git push *', tier: 'specific_deny' as const },
      { permission: 'Bash', pattern: 'ls *', tier: 'broad_allow' as const },
      { permission: 'bash', pattern: 'Git *', tier: 'broad_allow' as const },
    ].map(rule => ({
      ...rule,
      organization_id: organization.id,
      source: { type: 'admin_ui' as const },
    }))
  );
  mockedGetAuthorizedOrgContext.mockResolvedValue({
    success: true,
    data: { organization: await getOrganizationById(organization.id), user: { id: member.id } },
  } as never);
  return { organization };
}

function get(organizationId: string, ifNoneMatch?: string) {
  return GET(
    new NextRequest('http://localhost:3000', {
      headers: ifNoneMatch ? { 'If-None-Match': ifNoneMatch } : {},
    }),
    { params: Promise.resolve({ id: organizationId }) }
  );
}

describe('GET /api/organizations/[id]/permissions', () => {
  afterEach(cleanupDbForTest);

  test('returns the auth failure unchanged', async () => {
    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: false,
      nextResponse: NextResponse.json({ error: 'Organization not found' }, { status: 404 }),
    });

    expect((await get('org-1')).status).toBe(404);
  });

  test('returns the ordered policy to a member', async () => {
    const { organization } = await setup('enforce');

    const response = await get(organization.id);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(response.headers.get('etag')).toMatch(/^"[0-9a-f]{32}"$/);
    const body = PermissionPolicyResponseSchema.parse(await response.json());
    expect(body).toMatchObject({
      schemaVersion: 1,
      enforcement: 'enforce',
      defaultEffect: 'ask',
      evaluation: {
        tiers: ['broad_allow', 'specific_deny', 'narrow_allow', 'final_deny'],
        match: 'glob-v1',
      },
    });
    expect(body.rules.map(rule => [rule.tier, rule.permission, rule.pattern, rule.action])).toEqual(
      [
        ['broad_allow', 'Bash', 'ls *', 'allow'],
        ['broad_allow', 'bash', 'Git *', 'allow'],
        ['broad_allow', 'bash', 'git *', 'allow'],
        ['specific_deny', 'bash', 'git push *', 'deny'],
        ['final_deny', 'bash', '*>*', 'deny'],
      ]
    );
    expect(body.rules[0]).toEqual({
      id: expect.any(String),
      tier: 'broad_allow',
      permission: 'Bash',
      pattern: 'ls *',
      action: 'allow',
      scope: { type: 'organization' },
      description: null,
    });
  });

  test.each([
    ['enforcement is off', 'off' as const, true],
    ['AI Guardrails is not granted', 'enforce' as const, false],
  ])('returns an empty allow policy when %s', async (_name, enforcement, kiloEncrypt) => {
    const { organization } = await setup(enforcement, { kiloEncrypt });

    const response = await get(organization.id);

    expect(PermissionPolicyResponseSchema.parse(await response.json())).toEqual({
      schemaVersion: 1,
      revision: expect.any(Number),
      enforcement: 'off',
      defaultEffect: 'allow',
      evaluation: {
        tiers: ['broad_allow', 'specific_deny', 'narrow_allow', 'final_deny'],
        match: 'glob-v1',
      },
      rules: [],
    });
  });

  test('answers 304 for a matching If-None-Match', async () => {
    const { organization } = await setup('shadow');
    const etag = (await get(organization.id)).headers.get('etag') ?? '';

    for (const header of [etag, `W/${etag}`, `"other", ${etag}`, '*']) {
      const response = await get(organization.id, header);
      expect(response.status).toBe(304);
      expect(response.headers.get('etag')).toBe(etag);
      expect(await response.text()).toBe('');
    }
    expect((await get(organization.id, '"other"')).status).toBe(200);
  });

  test('changes the ETag and revision when rules or settings change', async () => {
    const { organization } = await setup('enforce');
    const first = await get(organization.id);
    const firstBody = await first.json();

    await db
      .delete(organization_permission_rules)
      .where(eq(organization_permission_rules.pattern, 'ls *'));
    const second = await get(organization.id);
    expect(second.headers.get('etag')).not.toBe(first.headers.get('etag'));
    expect((await second.json()).revision).not.toBe(firstBody.revision);

    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: true,
      data: {
        organization: {
          ...(await getOrganizationById(organization.id)),
          settings: {
            kilo_encrypt: true,
            guardrails: { permissions: { enforcement: 'enforce', default_effect: 'deny' } },
          },
        },
        user: { id: 'member' },
      },
    } as never);
    const third = await get(organization.id);
    expect(third.headers.get('etag')).not.toBe(second.headers.get('etag'));
  });
});

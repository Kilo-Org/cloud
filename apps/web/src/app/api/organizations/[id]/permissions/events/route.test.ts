import { describe, expect, test } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import {
  organization_permission_events_daily,
  organization_permission_rules,
} from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { GET } from '../route';
import {
  MAX_COMMAND_KEY_LENGTH,
  MAX_PERMISSION_EVENT_COUNT,
  MAX_PERMISSION_EVENTS_PER_REQUEST,
} from '@/lib/organizations/permissions/types';
import { POST } from './route';

jest.mock('@/lib/organizations/organization-auth');

const mockedGetAuthorizedOrgContext = jest.mocked(getAuthorizedOrgContext);
const RULE_ID = '00000000-0000-4000-8000-000000000001';
const DAY_MS = 24 * 60 * 60 * 1000;

function day(offset = 0) {
  return new Date(Date.now() - offset * DAY_MS).toISOString().slice(0, 10);
}

function entry(overrides: Record<string, unknown> = {}) {
  return {
    day: day(),
    permission: 'bash',
    commandKey: 'git push',
    decision: 'denied',
    count: 2,
    firstSeenAt: '2026-01-01T10:00:00.000Z',
    lastSeenAt: '2026-01-01T11:00:00.000Z',
    ...overrides,
  };
}

async function setup(enforcement: 'off' | 'shadow' | 'enforce', kiloEncrypt = true) {
  const owner = await insertTestUser();
  const member = await insertTestUser();
  const organization = await createTestOrganization('Permission events', owner.id, 0, {
    kilo_encrypt: kiloEncrypt,
    guardrails: { permissions: { enforcement, default_effect: 'allow' } },
  });
  mockedGetAuthorizedOrgContext.mockResolvedValue({
    success: true,
    data: { organization: await getOrganizationById(organization.id), user: { id: member.id } },
  } as never);
  return { organization, member };
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

async function policyRevision(organizationId: string) {
  const response = await GET(new NextRequest('http://localhost:3000'), {
    params: Promise.resolve({ id: organizationId }),
  });
  return ((await response.json()) as { revision: number }).revision;
}

describe('POST /api/organizations/[id]/permissions/events', () => {
  afterEach(cleanupDbForTest);

  test('changes the revision when a rule is swapped with the same count and newest update time', async () => {
    const { organization } = await setup('enforce');
    const newest = '2026-01-02 00:00:00.123456+00';
    const [, older] = await db
      .insert(organization_permission_rules)
      .values([
        {
          organization_id: organization.id,
          tier: 'final_deny',
          permission: 'bash',
          pattern: 'rm *',
          source: { type: 'admin_ui' as const },
          updated_at: newest,
        },
        {
          organization_id: organization.id,
          tier: 'final_deny',
          permission: 'bash',
          pattern: 'ls *',
          source: { type: 'admin_ui' as const },
          updated_at: '2026-01-01 00:00:00+00',
        },
      ])
      .returning();
    const before = await policyRevision(organization.id);
    expect(await (await post(organization.id, { client: 'cli', entries: [] })).json()).toEqual({
      revision: before,
    });

    await db.transaction(async tx => {
      await tx
        .delete(organization_permission_rules)
        .where(eq(organization_permission_rules.id, older.id));
      await tx.insert(organization_permission_rules).values({
        organization_id: organization.id,
        tier: 'final_deny',
        permission: 'bash',
        pattern: 'cat *',
        source: { type: 'admin_ui' as const },
        updated_at: '2026-01-01 12:00:00+00',
      });
    });

    const after = await policyRevision(organization.id);
    expect(after).not.toBe(before);
    expect(await (await post(organization.id, { client: 'cli', entries: [] })).json()).toEqual({
      revision: after,
    });
  });

  test('returns the auth failure unchanged and records nothing', async () => {
    mockedGetAuthorizedOrgContext.mockResolvedValue({
      success: false,
      nextResponse: NextResponse.json({ error: 'Organization not found' }, { status: 404 }),
    });

    const response = await post('org-1', { client: 'cli', entries: [entry()] });

    expect(response.status).toBe(404);
    expect(await db.select().from(organization_permission_events_daily)).toHaveLength(0);
  });

  test.each([
    ['invalid JSON', 'not json'],
    ['an unknown client', { client: 'toaster', entries: [entry()] }],
    [
      'too many entries',
      {
        client: 'cli',
        entries: Array.from({ length: MAX_PERMISSION_EVENTS_PER_REQUEST + 1 }, () => entry()),
      },
    ],
    ['a zero count', { client: 'cli', entries: [entry({ count: 0 })] }],
    [
      'a huge count',
      { client: 'cli', entries: [entry({ count: MAX_PERMISSION_EVENT_COUNT + 1 })] },
    ],
    ['a day in the future', { client: 'cli', entries: [entry({ day: day(-1) })] }],
    ['a day too old', { client: 'cli', entries: [entry({ day: day(3) })] }],
    ['an invalid day', { client: 'cli', entries: [entry({ day: '2026-13-01' })] }],
    ...[
      '$HOME',
      'echo `id`',
      'a | b',
      'a; b',
      'a && b',
      'a > b',
      'a < b',
      'git\npush',
      'git\u2028push',
      'git\u2029push',
    ].map(
      commandKey =>
        [
          `command key ${JSON.stringify(commandKey)}`,
          { client: 'cli', entries: [entry({ commandKey })] },
        ] as const
    ),
    [
      'a long command key',
      { client: 'cli', entries: [entry({ commandKey: 'a'.repeat(MAX_COMMAND_KEY_LENGTH + 1) })] },
    ],
    ['an empty permission', { client: 'cli', entries: [entry({ permission: ' ' })] }],
    ['an unknown decision', { client: 'cli', entries: [entry({ decision: 'maybe' })] }],
    ['an unknown tier', { client: 'cli', entries: [entry({ tier: 'medium' })] }],
    ['an invalid rule ID', { client: 'cli', entries: [entry({ ruleId: 'rule-1' })] }],
    [
      'first seen after last seen',
      {
        client: 'cli',
        entries: [
          entry({ firstSeenAt: '2026-01-02T00:00:00Z', lastSeenAt: '2026-01-01T00:00:00Z' }),
        ],
      },
    ],
  ])('rejects %s', async (_name, body) => {
    const { organization } = await setup('enforce');

    const response = await post(organization.id, body);

    expect(response.status).toBe(400);
    expect(await db.select().from(organization_permission_events_daily)).toHaveLength(0);
  });

  test('accumulates entries across and within requests and returns the revision', async () => {
    const { organization, member } = await setup('shadow');
    await db.insert(organization_permission_rules).values({
      organization_id: organization.id,
      permission: 'bash',
      pattern: 'git push *',
      tier: 'specific_deny',
      source: { type: 'admin_ui' },
    });
    const revision = await policyRevision(organization.id);

    const first = await post(organization.id, {
      client: 'cli',
      policyRevision: 7,
      entries: [
        entry({ day: day(2), ruleId: RULE_ID, tier: 'specific_deny' }),
        entry({
          day: day(2),
          count: 3,
          firstSeenAt: '2026-01-01T09:00:00.000Z',
          lastSeenAt: '2026-01-01T09:30:00.000Z',
        }),
        entry({ commandKey: '*', permission: 'read', decision: 'allowed', count: 1 }),
      ],
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ revision });

    await post(organization.id, {
      client: 'cli',
      policyRevision: 8,
      entries: [
        entry({
          day: day(2),
          count: 4,
          firstSeenAt: '2026-01-01T10:30:00.000Z',
          lastSeenAt: '2026-01-01T10:45:00.000Z',
          tier: 'final_deny',
        }),
      ],
    });

    const rows = await db.select().from(organization_permission_events_daily);
    expect(rows).toHaveLength(2);
    const denied = rows.find(row => row.decision === 'denied');
    expect(denied).toMatchObject({
      organization_id: organization.id,
      kilo_user_id: member.id,
      client: 'cli',
      day: day(2),
      permission: 'bash',
      command_key: 'git push',
      count: 9,
      last_rule_id: RULE_ID,
      last_tier: 'specific_deny',
      last_policy_revision: 7,
    });
    expect(new Date(denied?.first_seen_at ?? '').toISOString()).toBe('2026-01-01T09:00:00.000Z');
    expect(new Date(denied?.last_seen_at ?? '').toISOString()).toBe('2026-01-01T11:00:00.000Z');
    expect(rows.find(row => row.decision === 'allowed')).toMatchObject({
      permission: 'read',
      command_key: '*',
      count: 1,
      last_rule_id: null,
      last_tier: null,
    });
  });

  test('takes the last fields from a newer report', async () => {
    const { organization } = await setup('enforce');
    await post(organization.id, { client: 'vscode', entries: [entry({ tier: 'specific_deny' })] });

    await post(organization.id, {
      client: 'vscode',
      policyRevision: 3,
      entries: [entry({ lastSeenAt: '2026-01-01T12:00:00.000Z', tier: 'final_deny' })],
    });

    const [row] = await db.select().from(organization_permission_events_daily);
    expect(row).toMatchObject({ count: 4, last_tier: 'final_deny', last_policy_revision: 3 });
  });

  test.each([
    ['enforcement is off', 'off' as const, true],
    ['AI Guardrails is not granted', 'enforce' as const, false],
  ])('records nothing when %s', async (_name, enforcement, kiloEncrypt) => {
    const { organization } = await setup(enforcement, kiloEncrypt);

    const response = await post(organization.id, { client: 'cli', entries: [entry()] });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: await policyRevision(organization.id) });
    expect(await db.select().from(organization_permission_events_daily)).toHaveLength(0);
  });
});

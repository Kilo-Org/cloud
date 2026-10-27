import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  OWNER_POOL_CONVERSION_PATH,
  customRouterEntryKey,
  type OwnerPoolConversion,
  type OwnerPoolConversionResponse,
} from '@kilocode/auto-routing-contracts';
import { auto_routing_custom_routers, organizations, type User } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { sendViaMailgun } from '@kilocode/web-shared/lib/email-mailgun';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/config.server'),
  INTERNAL_API_SECRET: 'owner-pool-conversion-secret',
}));
jest.mock('@kilocode/web-shared/lib/email-mailgun', () => ({
  getEmailVerificationRecipient: jest.fn(() => null),
  sendViaMailgun: jest.fn(),
}));

const SONNET = 'anthropic/claude-sonnet-4';
const SECRET = 'owner-pool-conversion-secret';
const FLASH = 'google/gemini-2.5-flash';

function request(body: unknown, authorization: string | null = `Bearer ${SECRET}`) {
  return new NextRequest(`http://localhost:3000${OWNER_POOL_CONVERSION_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authorization ? { authorization } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function convert(...conversions: OwnerPoolConversion[]) {
  const response = await POST(request({ conversions }));
  expect(response.status).toBe(200);
  return ((await response.json()) as OwnerPoolConversionResponse).results;
}

function userConversion(user: User, models = [SONNET, FLASH]): OwnerPoolConversion {
  return { owner: { type: 'user', id: user.id }, mode: 'best_accuracy', models };
}

async function rows() {
  return db.select().from(auto_routing_custom_routers);
}

describe(`POST ${OWNER_POOL_CONVERSION_PATH}`, () => {
  let user: User;

  beforeEach(async () => {
    jest.clearAllMocks();
    user = await insertTestUser({ id: `oauth/test-${randomUUID()}` });
  });

  afterEach(async () => {
    expect(sendViaMailgun).not.toHaveBeenCalled();
    await cleanupDbForTest();
  });

  test.each([null, 'Bearer wrong-secret'])(
    'rejects unauthorized conversion with %s',
    async authorization => {
      const response = await POST(request({ conversions: [userConversion(user)] }, authorization));

      expect(response.status).toBe(401);
      expect(await rows()).toHaveLength(0);
    }
  );

  test.each([
    { conversions: [] },
    { conversions: [{ owner: { type: 'user', id: 'user' }, mode: 'best_accuracy', models: [] }] },
    {
      conversions: [
        { owner: { type: 'user', id: 'user' }, mode: 'best_accuracy', models: [SONNET, SONNET] },
      ],
    },
    { conversions: [{ owner: { type: 'user', id: 'user' }, mode: 'fastest', models: [SONNET] }] },
    'not json',
  ])('rejects invalid input without writing', async body => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  test('silently creates a marked efficient router for an arbitrary user ID', async () => {
    const results = await convert(userConversion(user));

    expect(results).toEqual([
      {
        owner: { type: 'user', id: user.id },
        outcome: 'created',
        modelId: 'kilo-auto/custom/efficient',
        noticesSent: 0,
        noticesFailed: 0,
      },
    ]);
    expect(await rows()).toEqual([
      expect.objectContaining({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        slug: 'efficient',
        base_router: 'efficient',
        mode: 'best_accuracy',
        entries: [
          { kind: 'gateway', model: SONNET },
          { kind: 'gateway', model: FLASH },
        ],
        default_entry_key: customRouterEntryKey({ kind: 'gateway', model: SONNET }),
        legacy_pool: true,
        legacy_mode_inherited: false,
      }),
    ]);
  });

  test('preserves preexisting null mode inheritance independently of the saved pool', async () => {
    const organization = await createTestOrganization('Inherited mode', user.id, 0);
    await convert({
      owner: { type: 'org', id: organization.id },
      mode: 'cost_per_accuracy',
      configuredMode: null,
      models: [FLASH],
    });

    expect(await rows()).toEqual([
      expect.objectContaining({
        owned_by_organization_id: organization.id,
        legacy_pool: true,
        legacy_mode_inherited: true,
      }),
    ]);
  });

  test('a rerun preserves edits to an already migrated router', async () => {
    await convert(userConversion(user));
    await db
      .update(auto_routing_custom_routers)
      .set({
        name: 'Edited',
        mode: 'cost_per_accuracy',
        entries: [{ kind: 'gateway', model: FLASH }],
        default_entry_key: customRouterEntryKey({ kind: 'gateway', model: FLASH }),
      })
      .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));
    const edited = await rows();

    expect(await convert(userConversion(user))).toEqual([
      expect.objectContaining({ outcome: 'exists' }),
    ]);
    expect(await rows()).toEqual(edited);
  });

  test('adopts an exact matching unmarked router without changing its definition', async () => {
    await db.insert(auto_routing_custom_routers).values({
      owned_by_user_id: user.id,
      slug: 'efficient',
      name: 'Existing name',
      base_router: 'efficient',
      mode: 'best_accuracy',
      entries: [
        { kind: 'gateway', model: FLASH },
        { kind: 'gateway', model: SONNET },
      ],
      default_entry_key: customRouterEntryKey({ kind: 'gateway', model: SONNET }),
    });
    const [before] = await rows();

    expect(await convert(userConversion(user))).toEqual([
      expect.objectContaining({ outcome: 'exists' }),
    ]);
    const [after] = await rows();
    expect(after).toEqual({ ...before, legacy_pool: true, updated_at: expect.any(String) });
  });

  test.each([
    {
      mode: 'best_accuracy' as const,
      base_router: 'efficient' as const,
      models: [FLASH],
      defaultModel: FLASH,
    },
    {
      mode: 'cost_per_accuracy' as const,
      base_router: 'efficient' as const,
      models: [SONNET, FLASH],
      defaultModel: SONNET,
    },
    {
      mode: 'best_accuracy' as const,
      base_router: 'frontier' as const,
      models: [SONNET, FLASH],
      defaultModel: SONNET,
    },
    {
      mode: 'best_accuracy' as const,
      base_router: 'efficient' as const,
      models: [SONNET, FLASH],
      defaultModel: FLASH,
    },
  ])('leaves a colliding router unmarked and untouched', async definition => {
    await db.insert(auto_routing_custom_routers).values({
      owned_by_user_id: user.id,
      slug: 'efficient',
      name: 'Not the migrated pool',
      base_router: definition.base_router,
      mode: definition.mode,
      entries: definition.models.map(model => ({ kind: 'gateway' as const, model })),
      default_entry_key: customRouterEntryKey({ kind: 'gateway', model: definition.defaultModel }),
    });
    const before = await rows();

    expect(await convert(userConversion(user))).toEqual([
      expect.objectContaining({ outcome: 'slug_taken' }),
    ]);
    expect(await rows()).toEqual(before);
  });

  test('respects the per-owner cap', async () => {
    await db.insert(auto_routing_custom_routers).values(
      Array.from({ length: 10 }, (_, index) => ({
        owned_by_user_id: user.id,
        slug: `router-${index}`,
        name: 'Existing',
        base_router: 'efficient' as const,
        mode: 'best_accuracy' as const,
        entries: [{ kind: 'gateway' as const, model: SONNET }],
        default_entry_key: customRouterEntryKey({ kind: 'gateway', model: SONNET }),
      }))
    );

    expect(await convert(userConversion(user))).toEqual([
      expect.objectContaining({ outcome: 'router_cap_reached' }),
    ]);
    expect(await rows()).toHaveLength(10);
  });

  test('concurrent retries create only one canonical router', async () => {
    const results = await Promise.all([
      convert(userConversion(user)),
      convert(userConversion(user)),
    ]);

    expect(
      results
        .flat()
        .map(result => result.outcome)
        .sort()
    ).toEqual(['created', 'exists']);
    expect(await rows()).toHaveLength(1);
  });

  test('silently creates a marked organization router', async () => {
    const organization = await createTestOrganization('Acme', user.id, 0);

    const results = await convert({
      owner: { type: 'org', id: organization.id },
      mode: 'cost_per_accuracy',
      models: [FLASH],
    });

    expect(results).toEqual([
      expect.objectContaining({
        outcome: 'created',
        modelId: 'kilo-auto/custom/org/efficient',
        noticesSent: 0,
        noticesFailed: 0,
      }),
    ]);
    expect(await rows()).toEqual([
      expect.objectContaining({
        owned_by_organization_id: organization.id,
        owned_by_user_id: null,
        legacy_pool: true,
      }),
    ]);
  });

  test('keeps request order for missing owners and deleted organizations', async () => {
    const organization = await createTestOrganization('Deleted', user.id, 0);
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organization.id));
    const pool = { mode: 'best_accuracy' as const, models: [SONNET] };

    const results = await convert(
      { owner: { type: 'user', id: 'missing-user' }, ...pool },
      { owner: { type: 'org', id: randomUUID() }, ...pool },
      { owner: { type: 'org', id: 'not-a-uuid' }, ...pool },
      { owner: { type: 'org', id: organization.id }, ...pool },
      userConversion(user)
    );

    expect(results.map(result => result.outcome)).toEqual([
      'owner_not_found',
      'owner_not_found',
      'owner_not_found',
      'owner_not_found',
      'created',
    ]);
    expect(await rows()).toHaveLength(1);
  });

  test('rejects a pool model that cannot be a gateway entry without writing', async () => {
    expect(await convert(userConversion(user, ['client:ollama/llama']))).toEqual([
      expect.objectContaining({ outcome: 'failed', noticesSent: 0, noticesFailed: 0 }),
    ]);
    expect(await rows()).toHaveLength(0);
  });

  test('isolates a failed conversion from the rest of the batch', async () => {
    const other = await insertTestUser();
    const transaction = jest
      .spyOn(db, 'transaction')
      .mockRejectedValueOnce(new Error('connection reset'));
    const results = await convert(userConversion(user), userConversion(other)).finally(() =>
      transaction.mockRestore()
    );

    expect(results.map(result => result.outcome)).toEqual(['failed', 'created']);
    expect(await rows()).toEqual([expect.objectContaining({ owned_by_user_id: other.id })]);
  });
});

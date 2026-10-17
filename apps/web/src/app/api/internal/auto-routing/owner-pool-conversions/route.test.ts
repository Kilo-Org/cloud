import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  OWNER_POOL_CONVERSION_PATH,
  customRouterEntryKey,
  type OwnerPoolConversion,
  type OwnerPoolConversionResponse,
} from '@kilocode/auto-routing-contracts';
import {
  auto_routing_custom_routers,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import { NEXTAUTH_URL } from '@kilocode/web-shared/lib/config.server';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { sendViaMailgun } from '@kilocode/web-shared/lib/email-mailgun';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { captureException } from '@sentry/nextjs';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { POST } from './route';

const SECRET = 'owner-pool-conversion-secret';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<Record<string, unknown>>('@kilocode/web-shared/lib/config.server'),
  INTERNAL_API_SECRET: 'owner-pool-conversion-secret',
}));
jest.mock('@kilocode/web-shared/lib/email-mailgun', () => ({
  getEmailVerificationRecipient: jest.fn(() => null),
  sendViaMailgun: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<Record<string, unknown>>('@sentry/nextjs'),
  captureException: jest.fn(),
}));

const mockedSendViaMailgun = jest.mocked(sendViaMailgun);
const mockedCaptureException = jest.mocked(captureException);

const SONNET = 'anthropic/claude-sonnet-4';
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

function sentEmails() {
  return mockedSendViaMailgun.mock.calls.map(([message]) => message);
}

async function routers() {
  return db.select().from(auto_routing_custom_routers);
}

describe(`POST ${OWNER_POOL_CONVERSION_PATH}`, () => {
  let user: User;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockedSendViaMailgun.mockResolvedValue({} as never);
    user = await insertTestUser();
  });

  afterEach(async () => {
    await cleanupDbForTest();
  });

  describe('auth and validation', () => {
    test.each([
      ['without a bearer token', null],
      ['with the wrong secret', 'Bearer not-the-secret'],
    ])('returns 401 %s and converts nothing', async (_label, authorization) => {
      const response = await POST(request({ conversions: [userConversion(user)] }, authorization));

      expect(response.status).toBe(401);
      expect(await routers()).toHaveLength(0);
      expect(mockedSendViaMailgun).not.toHaveBeenCalled();
    });

    const pool = { owner: { type: 'user', id: 'user-1' }, mode: 'best_accuracy', models: [SONNET] };
    test.each([
      ['an empty pool', { conversions: [{ ...pool, models: [] }] }],
      ['duplicate pool models', { conversions: [{ ...pool, models: [SONNET, SONNET] }] }],
      ['an unknown mode', { conversions: [{ ...pool, mode: 'fastest' }] }],
      ['no conversions', { conversions: [] }],
      ['a body that is not JSON', 'not json'],
    ])('returns 400 for %s', async (_label, body) => {
      const response = await POST(request(body));

      expect(response.status).toBe(400);
      expect(await routers()).toHaveLength(0);
    });
  });

  describe('user pools', () => {
    test('creates the efficient router from the pool and notifies the user', async () => {
      const results = await convert(userConversion(user));

      expect(results).toEqual([
        {
          owner: { type: 'user', id: user.id },
          outcome: 'created',
          modelId: 'kilo-auto/custom/efficient',
          noticesSent: 1,
          noticesFailed: 0,
        },
      ]);
      const [row] = await routers();
      expect(row).toMatchObject({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        created_by_user_id: user.id,
        slug: 'efficient',
        name: 'Efficient',
        base_router: 'efficient',
        mode: 'best_accuracy',
        entries: [
          { kind: 'gateway', model: SONNET },
          { kind: 'gateway', model: FLASH },
        ],
        default_entry_key: customRouterEntryKey({ kind: 'gateway', model: SONNET }),
      });
      expect(sentEmails()).toEqual([
        expect.objectContaining({
          to: user.google_user_email,
          category: 'autoRoutingPoolConverted',
        }),
      ]);
      const html = sentEmails()[0]?.html;
      expect(html).toContain('kilo-auto/custom/efficient');
      expect(html).toContain(`href="${NEXTAUTH_URL}/profile"`);
    });

    test('a re-run reports exists without writing or notifying again', async () => {
      await convert(userConversion(user));
      const [created] = await routers();

      const results = await convert(userConversion(user));

      expect(results).toEqual([
        expect.objectContaining({ outcome: 'exists', noticesSent: 0, noticesFailed: 0 }),
      ]);
      expect(await routers()).toEqual([created]);
      expect(mockedSendViaMailgun).toHaveBeenCalledTimes(1);
    });

    test.each([
      ['other entries', { mode: 'best_accuracy', base: 'efficient', models: [FLASH] }],
      ['the same size and another model', { mode: 'best_accuracy', base: 'efficient', models: [SONNET, 'openai/gpt-5'] }],
      ['the same entries in another mode', { mode: 'cost_per_accuracy', base: 'efficient', models: [SONNET, FLASH] }],
      ['the same entries on another base', { mode: 'best_accuracy', base: 'frontier', models: [SONNET, FLASH] }],
      ['the same entries and another default', { mode: 'best_accuracy', base: 'efficient', models: [FLASH, SONNET] }],
    ] as const)(
      'reports slug_taken when the owner has its own efficient router with %s',
      async (_label, own) => {
        await db.insert(auto_routing_custom_routers).values({
          owned_by_user_id: user.id,
          created_by_user_id: user.id,
          slug: 'efficient',
          name: 'My own',
          base_router: own.base,
          mode: own.mode,
          entries: own.models.map(model => ({ kind: 'gateway' as const, model })),
          default_entry_key: customRouterEntryKey({ kind: 'gateway', model: own.models[0] }),
        });
        const [ownRouter] = await routers();

        const results = await convert(userConversion(user));

        expect(results).toEqual([
          expect.objectContaining({ outcome: 'slug_taken', noticesSent: 0, noticesFailed: 0 }),
        ]);
        expect(await routers()).toEqual([ownRouter]);
        expect(mockedSendViaMailgun).not.toHaveBeenCalled();
      }
    );

    test('reports failed and writes nothing for a pool model that cannot be a gateway entry', async () => {
      const results = await convert(userConversion(user, ['client:ollama/llama']));

      expect(results).toEqual([expect.objectContaining({ outcome: 'failed' })]);
      expect(await routers()).toHaveLength(0);
      expect(mockedSendViaMailgun).not.toHaveBeenCalled();
    });

    test('reports failed for one conversion without failing the rest of the batch', async () => {
      const other = await insertTestUser();
      const transaction = jest
        .spyOn(db, 'transaction')
        .mockRejectedValueOnce(new Error('connection reset'));

      const results = await convert(userConversion(user), userConversion(other)).finally(() =>
        transaction.mockRestore()
      );

      expect(results.map(result => result.outcome)).toEqual(['failed', 'created']);
      expect(mockedCaptureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'connection reset' }),
        expect.objectContaining({ extra: { ownerType: 'user', ownerId: user.id } })
      );
    });

    test('skips an owner already at the custom router cap', async () => {
      await db.insert(auto_routing_custom_routers).values(
        Array.from({ length: 10 }, (_, index) => ({
          owned_by_user_id: user.id,
          created_by_user_id: user.id,
          slug: `router-${index}`,
          name: `Router ${index}`,
          base_router: 'efficient' as const,
          mode: 'cost_per_accuracy' as const,
          entries: [{ kind: 'gateway' as const, model: SONNET }],
          default_entry_key: customRouterEntryKey({ kind: 'gateway', model: SONNET }),
        }))
      );

      const results = await convert(userConversion(user));

      expect(results).toEqual([
        expect.objectContaining({ outcome: 'router_cap_reached', noticesSent: 0 }),
      ]);
      const efficient = await db
        .select()
        .from(auto_routing_custom_routers)
        .where(eq(auto_routing_custom_routers.slug, 'efficient'));
      expect(efficient).toHaveLength(0);
      expect(mockedSendViaMailgun).not.toHaveBeenCalled();
    });

    test('counts a failed notice without rolling back the router', async () => {
      mockedSendViaMailgun.mockRejectedValue(new Error('Mailgun unavailable'));

      const results = await convert(userConversion(user));

      expect(results).toEqual([
        expect.objectContaining({ outcome: 'created', noticesSent: 0, noticesFailed: 1 }),
      ]);
      expect(await routers()).toHaveLength(1);
      expect(mockedCaptureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Mailgun unavailable' }),
        expect.objectContaining({ extra: { ownerType: 'user', ownerId: user.id } })
      );
    });
  });

  describe('organization pools', () => {
    test('creates the org router and notifies only owners, admins, and billing managers', async () => {
      const organization = await createTestOrganization('Acme', user.id, 0);
      const admin = await insertTestUser();
      const billingManager = await insertTestUser();
      const member = await insertTestUser();
      await db.insert(organization_memberships).values([
        { organization_id: organization.id, kilo_user_id: admin.id, role: 'admin' },
        {
          organization_id: organization.id,
          kilo_user_id: billingManager.id,
          role: 'billing_manager',
        },
        { organization_id: organization.id, kilo_user_id: member.id, role: 'member' },
      ]);

      const results = await convert({
        owner: { type: 'org', id: organization.id },
        mode: 'cost_per_accuracy',
        models: [FLASH],
      });

      expect(results).toEqual([
        {
          owner: { type: 'org', id: organization.id },
          outcome: 'created',
          modelId: 'kilo-auto/custom/org/efficient',
          noticesSent: 3,
          noticesFailed: 0,
        },
      ]);
      const [row] = await routers();
      expect(row).toMatchObject({
        owned_by_user_id: null,
        owned_by_organization_id: organization.id,
        created_by_user_id: null,
        mode: 'cost_per_accuracy',
        entries: [{ kind: 'gateway', model: FLASH }],
        default_entry_key: customRouterEntryKey({ kind: 'gateway', model: FLASH }),
      });
      const recipients = sentEmails().map(email => email.to);
      expect(recipients.sort()).toEqual(
        [user.google_user_email, admin.google_user_email, billingManager.google_user_email].sort()
      );
      expect(recipients).not.toContain(member.google_user_email);
      expect(sentEmails()[0]?.html).toContain(
        `${NEXTAUTH_URL}/organizations/${organization.id}/providers-and-models`
      );
    });
  });

  describe('missing owners', () => {
    test('reports owner_not_found per conversion and keeps request order', async () => {
      const deletedOrganization = await createTestOrganization('Gone', user.id, 0);
      await db
        .update(organizations)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(organizations.id, deletedOrganization.id));
      const pool = { mode: 'best_accuracy' as const, models: [SONNET] };

      const results = await convert(
        { owner: { type: 'user', id: 'missing-user' }, ...pool },
        { owner: { type: 'org', id: randomUUID() }, ...pool },
        { owner: { type: 'org', id: 'not-a-uuid' }, ...pool },
        { owner: { type: 'org', id: deletedOrganization.id }, ...pool },
        userConversion(user)
      );

      expect(results.map(result => result.outcome)).toEqual([
        'owner_not_found',
        'owner_not_found',
        'owner_not_found',
        'owner_not_found',
        'created',
      ]);
      expect(await routers()).toHaveLength(1);
      expect(mockedSendViaMailgun).toHaveBeenCalledTimes(1);
    });
  });
});

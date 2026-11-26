import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  customRouterEntryKey,
  MAX_CLIENT_CONTEXT_LENGTH,
  MAX_CLIENT_VARIANTS,
  MAX_CUSTOM_ROUTER_MODEL_ID_LENGTH,
  type ClientCustomRouterEntry,
  type CustomRouterEntry,
  type CustomRouterListResponse,
  type CustomRouterResponse,
  type CustomRouterVariantStatus,
} from '@kilocode/auto-routing-contracts';
import {
  admin_action_audit_logs,
  auto_routing_custom_routers,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import {
  getCustomRouterStatus,
  getPaidBenchmarkProgress,
  getPlatformMeasurements,
  lookupCustomRouterBlockedModels,
  pausePoolBenchmark,
  registerOwnerBenchmarkProfiles,
  requestPaidBenchmarkQuote,
  startPaidBenchmark,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import {
  getDirectByokModelsForOrganization,
  getDirectByokModelsForUser,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { getAvailableModelsForOrganization } from '@kilocode/web-shared/lib/organizations/organization-models';
import { requireActiveSubscriptionOrTrial } from '@kilocode/web-shared/lib/organizations/trial-middleware';
import {
  getUserFromAuth,
  requireStaffAuthorityForRequest,
} from '@kilocode/web-shared/lib/user/server';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { TRPCError } from '@trpc/server';
import { eq, inArray, sql } from 'drizzle-orm';
import { NextRequest, type NextResponse } from 'next/server';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { staffStepUpRefusal } from '@/tests/helpers/staff-refusal.helper';
import { MAX_CUSTOM_ROUTER_BODY_BYTES, lockOwner } from '@/lib/auto-routing-custom-routers';
import { GET as listRouters, POST as createRouter } from './route';
import {
  DELETE as deleteRouter,
  GET as getRouter,
  PATCH as updateRouter,
} from './[scope]/[slug]/route';
import {
  DELETE as removeClientEntry,
  POST as registerClientEntry,
} from './[scope]/[slug]/client-entries/route';

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/lib/organizations/trial-middleware');
jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
  getCustomRouterStatus: jest.fn(),
  getPlatformMeasurements: jest.fn(),
  getPaidBenchmarkProgress: jest.fn(),
  lookupCustomRouterBlockedModels: jest.fn(),
  pausePoolBenchmark: jest.fn(),
  registerOwnerBenchmarkProfiles: jest.fn(),
  requestPaidBenchmarkQuote: jest.fn(),
  startPaidBenchmark: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/openrouter', () => ({
  getEnhancedOpenRouterModels: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModelsForUser: jest.fn(),
  getDirectByokModelsForOrganization: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organization-models', () => ({
  getAvailableModelsForOrganization: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedRequireActiveSubscription = jest.mocked(requireActiveSubscriptionOrTrial);
const mockedGetStatus = jest.mocked(getCustomRouterStatus);
const mockedGetPlatformMeasurements = jest.mocked(getPlatformMeasurements);
const mockedBenchmarkProgress = jest.mocked(getPaidBenchmarkProgress);
const mockedPoolPause = jest.mocked(pausePoolBenchmark);
const mockedQuote = jest.mocked(requestPaidBenchmarkQuote);
const mockedStart = jest.mocked(startPaidBenchmark);
const mockedBlocked = jest.mocked(lookupCustomRouterBlockedModels);
const mockedRegister = jest.mocked(registerOwnerBenchmarkProfiles);
const mockedGetEnhanced = jest.mocked(getEnhancedOpenRouterModels);
const mockedGetByokUser = jest.mocked(getDirectByokModelsForUser);
const mockedGetByokOrg = jest.mocked(getDirectByokModelsForOrganization);
const mockedGetOrgModels = jest.mocked(getAvailableModelsForOrganization);

const SONNET = 'anthropic/claude-sonnet-4';
const FLASH = 'google/gemini-2.5-flash';
const DENIED = 'openai/gpt-5';
const BYOK = 'chutes-byok/qwen3-coder';

function model(id: string) {
  return {
    id,
    name: id,
    created: 0,
    description: id,
    architecture: { input_modalities: ['text'], output_modalities: ['text'], tokenizer: 'Other' },
    top_provider: { is_moderated: false, context_length: 100_000 },
    pricing: { prompt: '0', completion: '0' },
    context_length: 100_000,
  };
}

const gateway = (id: string): CustomRouterEntry => ({ kind: 'gateway', model: id });

function clientEntry(modelId: string, variants: string[] = []): ClientCustomRouterEntry {
  return {
    kind: 'client',
    provider: 'ollama',
    model: modelId,
    variants,
    capabilities: {
      contextLength: 32_000,
      inputModalities: ['text'],
      toolCall: true,
      reasoning: false,
    },
    pricing: null,
  };
}

function routerBody(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'user',
    slug: 'coding',
    name: 'Coding',
    baseRouter: 'efficient',
    mode: 'cost_per_accuracy',
    entries: [gateway(SONNET)],
    defaultEntryKey: customRouterEntryKey(gateway(SONNET)),
    ...overrides,
  };
}

const BASE_URL = 'http://localhost:3000/api/auto-routing/custom-routers';

function request(path: string, init: { method?: string; body?: unknown } = {}) {
  return new NextRequest(`${BASE_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const params = (scope: string, slug: string) => ({ params: Promise.resolve({ scope, slug }) });

function signIn(user: User, organizationId?: string) {
  mockedGetUserFromAuth.mockResolvedValue({
    user,
    authFailedResponse: null,
    ...(organizationId ? { organizationId } : {}),
  } as never);
}

async function create(body: Record<string, unknown>, query = '') {
  const response = await createRouter(request(query, { method: 'POST', body }));
  return { status: response.status, body: (await response.json()) as never };
}

async function list(query = '') {
  const response = await listRouters(request(query));
  return { status: response.status, body: (await response.json()) as CustomRouterListResponse };
}

async function errorOf(response: NextResponse | Response) {
  return { status: response.status, body: (await response.json()) as { error: { code: string } } };
}

function variants(statuses: CustomRouterVariantStatus['status'][]): CustomRouterVariantStatus[] {
  return statuses.map((status, index) => ({
    variant: index === 0 ? null : `v${index}`,
    status,
    failureReason: status === 'failed' ? 'boom' : null,
    linked: false,
  }));
}

/** Proves whether the owner lock is held right now without throwing on a held lock. */
async function probeOwnerLock(
  owner: User
): Promise<{ free: true } | { free: false; error: string }> {
  try {
    await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL statement_timeout = '500ms'`);
      await lockOwner(tx, { type: 'user', id: owner.id });
    });
    return { free: true };
  } catch (error) {
    return { free: false, error: error instanceof Error ? error.message : String(error) };
  }
}

describe('/api/auto-routing/custom-routers', () => {
  let user: User;

  beforeEach(async () => {
    jest.resetAllMocks();
    user = await insertTestUser();
    signIn(user);
    mockedRequireActiveSubscription.mockResolvedValue({ isReadOnly: false, daysRemaining: 30 });
    mockedBenchmarkProgress.mockResolvedValue({ ok: true, body: { status: 'empty' } });
    // A fence pause that finds nothing live answers `empty`; a live one answers `paused`.
    mockedPoolPause.mockResolvedValue({ ok: true, body: { status: 'empty' } });
    mockedBlocked.mockImplementation(async request => ({
      router: request.router,
      blocked: [],
    }));
    mockedGetPlatformMeasurements.mockResolvedValue({
      status: 200,
      body: { baseRouter: 'efficient', models: [{ model: SONNET, variants: [null] }] },
    });
    mockedGetEnhanced.mockResolvedValue({ data: [model(SONNET), model(FLASH), model(DENIED)] });
    mockedGetByokUser.mockResolvedValue([model(BYOK)] as never);
    mockedGetByokOrg.mockResolvedValue([]);
    mockedGetOrgModels.mockResolvedValue({ data: [model(SONNET), model(FLASH)] } as never);
    mockedGetStatus.mockImplementation(async request => ({
      status: 200,
      body: {
        entries: request.entries.map(entry => ({
          key: customRouterEntryKey(entry),
          variants: variants(['missing']),
        })),
      },
    }));
  });

  afterEach(async () => {
    await cleanupDbForTest();
  });

  describe('migrated owner pools', () => {
    test('all owners can discover and create routers after cutover', async () => {
      await create(routerBody());
      await create(routerBody({ slug: 'efficient' }));
      const listed = await list();
      expect(listed.body.canCreate).toBe(true);
      expect(listed.body.routers).toHaveLength(2);
      expect((await create(routerBody({ slug: 'another' }))).status).toBe(201);
    });

    test('returned migrated routers omit compatibility metadata', async () => {
      await create(routerBody({ slug: 'efficient' }));
      await db
        .update(auto_routing_custom_routers)
        .set({ legacy_pool: true, legacy_mode_inherited: true })

        .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));
      const listed = await list();
      expect(listed.body.routers[0]).not.toHaveProperty('legacyPool');
      expect(listed.body.routers[0]).not.toHaveProperty('legacyModeInherited');
    });

    test('releases migrated base changes and deletion while retaining provenance', async () => {
      await create(routerBody({ slug: 'efficient' }));
      await db
        .update(auto_routing_custom_routers)
        .set({ legacy_pool: true })
        .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));
      expect(
        (
          await updateRouter(
            request('/user/efficient', { method: 'PATCH', body: { baseRouter: 'frontier' } }),
            params('user', 'efficient')
          )
        ).status
      ).toBe(200);
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row).toMatchObject({ base_router: 'frontier', legacy_pool: true });
      expect(
        (
          await deleteRouter(
            request('/user/efficient', { method: 'DELETE' }),
            params('user', 'efficient')
          )
        ).status
      ).toBe(204);
    });

    test.each(['member', 'billing_manager'] as const)(
      'an organization %s retains existing role permissions',
      async role => {
        const organization = await createTestOrganization('Migrated', user.id, 0);
        await create(
          routerBody({ scope: 'org', slug: 'efficient' }),
          `?organizationId=${organization.id}`
        );
        await db
          .update(auto_routing_custom_routers)
          .set({ legacy_pool: true })
          .where(eq(auto_routing_custom_routers.owned_by_organization_id, organization.id));
        const member = await insertTestUser();
        await db.insert(organization_memberships).values({
          organization_id: organization.id,
          kilo_user_id: member.id,
          role,
        });
        signIn(member, organization.id);

        const listed = await list();
        expect(listed.body.routers).toEqual([
          expect.objectContaining({
            modelId: 'kilo-auto/custom/org/efficient',
            canEdit: role === 'billing_manager',
          }),
        ]);
        const response = await updateRouter(
          request('/org/efficient', { method: 'PATCH', body: { name: 'Edited' } }),
          params('org', 'efficient')
        );
        expect(response.status).toBe(role === 'billing_manager' ? 200 : 403);
      }
    );

    test.each(['owner', 'admin', 'billing_manager'] as const)(
      'a parent %s can discover and edit its child routers',
      async role => {
        const parent = await createTestOrganization('Parent', user.id, 0);
        const childOwner = await insertTestUser();
        const child = await createTestOrganization('Child', childOwner.id, 0);
        await db
          .update(organizations)
          .set({ parent_organization_id: parent.id })
          .where(eq(organizations.id, child.id));
        await db
          .update(organization_memberships)
          .set({ role })
          .where(eq(organization_memberships.kilo_user_id, user.id));
        signIn(childOwner, child.id);
        await create(routerBody({ scope: 'org', slug: 'efficient' }));
        await create(routerBody({ scope: 'org', slug: 'unrelated-router' }));
        await db
          .update(auto_routing_custom_routers)
          .set({ legacy_pool: true })
          .where(eq(auto_routing_custom_routers.slug, 'efficient'));
        signIn(user, child.id);

        const listed = await list();
        expect(listed.status).toBe(200);
        expect(listed.body.canCreate).toBe(true);
        expect(listed.body.routers).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ modelId: 'kilo-auto/custom/org/efficient', canEdit: true }),
            expect.objectContaining({
              modelId: 'kilo-auto/custom/org/unrelated-router',
              canEdit: true,
            }),
          ])
        );
        expect(
          (await getRouter(request('/org/efficient'), params('org', 'efficient'))).status
        ).toBe(200);
        expect(
          (
            await updateRouter(
              request('/org/efficient', {
                method: 'PATCH',
                body: { name: 'Inherited editor change' },
              }),
              params('org', 'efficient')
            )
          ).status
        ).toBe(200);
        expect((await create(routerBody({ scope: 'org', slug: 'new-router' }))).status).toBe(201);
        expect(
          (await getRouter(request('/org/unrelated-router'), params('org', 'unrelated-router')))
            .status
        ).toBe(200);
        expect(
          (
            await updateRouter(
              request('/org/unrelated-router', {
                method: 'PATCH',
                body: { name: 'Inherited editor change' },
              }),
              params('org', 'unrelated-router')
            )
          ).status
        ).toBe(200);
        expect(mockedRequireActiveSubscription).toHaveBeenCalledWith(child.id);
      }
    );

    test('a parent editor retains its effective role over a direct child member role', async () => {
      const parent = await createTestOrganization('Parent', user.id, 0);
      const childOwner = await insertTestUser();
      const child = await createTestOrganization('Child', childOwner.id, 0);
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, child.id));
      await db.insert(organization_memberships).values({
        organization_id: child.id,
        kilo_user_id: user.id,
        role: 'member',
      });
      signIn(childOwner, child.id);
      await create(routerBody({ scope: 'org', slug: 'efficient' }));
      await db
        .update(auto_routing_custom_routers)
        .set({ legacy_pool: true })
        .where(eq(auto_routing_custom_routers.owned_by_organization_id, child.id));
      signIn(user, child.id);

      expect((await list()).body.routers).toEqual([expect.objectContaining({ canEdit: true })]);
      expect(
        (
          await updateRouter(
            request('/org/efficient', { method: 'PATCH', body: { name: 'Effective owner edit' } }),
            params('org', 'efficient')
          )
        ).status
      ).toBe(200);
    });

    test('hierarchy access excludes sibling editors, parent ordinary members, and grandparent owners', async () => {
      const parentOwner = await insertTestUser();
      const parent = await createTestOrganization('Parent', parentOwner.id, 0);
      const child = await createTestOrganization('Child', user.id, 0);
      const sibling = await createTestOrganization('Sibling', parentOwner.id, 0);
      const grandchild = await createTestOrganization('Grandchild', parentOwner.id, 0);
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, child.id));
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, sibling.id));
      await db
        .update(organizations)
        .set({ parent_organization_id: sibling.id })
        .where(eq(organizations.id, grandchild.id));
      signIn(parentOwner);
      for (const organization of [child, sibling, grandchild]) {
        await create(
          routerBody({ scope: 'org', slug: 'efficient' }),
          `?organizationId=${organization.id}`
        );
      }
      await db
        .update(auto_routing_custom_routers)
        .set({ legacy_pool: true })
        .where(
          inArray(auto_routing_custom_routers.owned_by_organization_id, [
            child.id,
            sibling.id,
            grandchild.id,
          ])
        );
      signIn(user);
      expect((await list(`?organizationId=${child.id}`)).status).toBe(200);
      for (const organization of [sibling, grandchild]) {
        expect((await list(`?organizationId=${organization.id}`)).status).toBe(403);
        expect(
          (
            await getRouter(
              request(`/org/efficient?organizationId=${organization.id}`),
              params('org', 'efficient')
            )
          ).status
        ).toBe(403);
        expect(
          (
            await updateRouter(
              request(`/org/efficient?organizationId=${organization.id}`, {
                method: 'PATCH',
                body: { name: 'Denied' },
              }),
              params('org', 'efficient')
            )
          ).status
        ).toBe(403);
      }
      const grandparentEditor = await insertTestUser();
      await db.insert(organization_memberships).values({
        organization_id: parent.id,
        kilo_user_id: grandparentEditor.id,
        role: 'owner',
      });
      signIn(grandparentEditor, sibling.id);
      expect((await list()).status).toBe(200);
      signIn(grandparentEditor, grandchild.id);
      expect((await list()).status).toBe(403);
      const ordinaryParentMember = await insertTestUser();
      await db.insert(organization_memberships).values({
        organization_id: sibling.id,
        kilo_user_id: ordinaryParentMember.id,
        role: 'member',
      });
      signIn(ordinaryParentMember, grandchild.id);
      expect((await list()).status).toBe(403);
    });
  });
  describe('personal routers', () => {
    test('creates a router owned by the authenticated user, ignoring owner fields in the body', async () => {
      const other = await insertTestUser();

      const created = await create(
        routerBody({ ownerId: other.id, ownerType: 'org', owned_by_user_id: other.id })
      );

      expect(created.status).toBe(201);
      const { router } = created.body as CustomRouterResponse;
      expect(router).toMatchObject({
        scope: 'user',
        slug: 'coding',
        modelId: 'kilo-auto/custom/coding',
        canEdit: true,
      });
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row).toMatchObject({
        owned_by_user_id: user.id,
        owned_by_organization_id: null,
        created_by_user_id: user.id,
      });
    });

    test('another user cannot read or delete the router', async () => {
      await create(routerBody());
      signIn(await insertTestUser());

      const read = await errorOf(
        await getRouter(request('/user/coding'), params('user', 'coding'))
      );
      const deleted = await errorOf(
        await deleteRouter(request('/user/coding', { method: 'DELETE' }), params('user', 'coding'))
      );

      expect(read.status).toBe(404);
      expect(deleted.status).toBe(404);
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(1);
    });

    test('does not enroll the owner in platform benchmarks on create, update, or a client entry', async () => {
      expect((await create(routerBody())).status).toBe(201);

      const updated = await updateRouter(
        request('/user/coding', {
          method: 'PATCH',
          body: {
            entries: [gateway(FLASH)],
            defaultEntryKey: customRouterEntryKey(gateway(FLASH)),
          },
        }),
        params('user', 'coding')
      );
      expect(updated.status).toBe(200);

      const registered = await registerClientEntry(
        request('/user/coding/client-entries', {
          method: 'POST',
          body: { entry: clientEntry('qwen3:8b') },
        }),
        params('user', 'coding')
      );
      expect(registered.status).toBe(200);

      // Benchmarking a user pool now needs the owner's explicit paid confirmation, so a save must
      // never request platform benchmarks on the owner's behalf.
      expect(mockedRegister).not.toHaveBeenCalled();
    });

    test('refuses a newly added model that is permanently unavailable', async () => {
      mockedBlocked.mockResolvedValueOnce({
        router: 'efficient',
        blocked: [
          {
            model: FLASH,
            pair: { model: FLASH, variant: null },
            failure: {
              kind: 'permanent',
              failureClass: 'catalog_absent',
              reason: 'model is gone from the catalog',
              attempts: 6,
              firstFailedAt: '2026-11-19T00:00:00.000Z',
              lastFailedAt: '2026-11-19T01:00:00.000Z',
              cause: 'terminal_class',
            },
          },
        ],
      });

      const created = await create(
        routerBody({
          entries: [gateway(SONNET), gateway(FLASH)],
          defaultEntryKey: customRouterEntryKey(gateway(SONNET)),
        })
      );

      expect(created.status).toBe(400);
      expect(created.body).toMatchObject({
        error: {
          code: 'invalid_request',
          message: expect.stringContaining('permanently unavailable'),
        },
      });
      expect(mockedBlocked).toHaveBeenCalledWith({ router: 'efficient', models: [SONNET, FLASH] });
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
    });

    test('refuses a new model when the availability check cannot answer', async () => {
      mockedBlocked.mockRejectedValueOnce(new Error('benchmark worker is not configured'));

      const created = await create(
        routerBody({
          entries: [gateway(SONNET), gateway(FLASH)],
          defaultEntryKey: customRouterEntryKey(gateway(SONNET)),
        })
      );

      expect(created.status).toBe(500);
      expect(created.body).toMatchObject({ error: { code: 'internal_error' } });
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
    });

    test('still saves a pool that adds no gateway model while the check is unavailable', async () => {
      await create(
        routerBody({
          entries: [gateway(FLASH)],
          defaultEntryKey: customRouterEntryKey(gateway(FLASH)),
        })
      );
      // The fixture create added the only gateway model, so it made the one lookup. Clear that
      // history before making the lookup fail, then prove the rename save checks nothing.
      mockedBlocked.mockClear();
      mockedBlocked.mockRejectedValue(new Error('benchmark worker is not configured'));

      const updated = await updateRouter(
        request('/user/coding', { method: 'PATCH', body: { name: 'Renamed' } }),
        params('user', 'coding')
      );

      expect(updated.status).toBe(200);
      expect(mockedBlocked).not.toHaveBeenCalled();
    });

    test('keeps a model the pool already has without checking it again', async () => {
      await create(
        routerBody({
          entries: [gateway(FLASH)],
          defaultEntryKey: customRouterEntryKey(gateway(FLASH)),
        })
      );
      mockedBlocked.mockClear();

      const updated = await updateRouter(
        request('/user/coding', {
          method: 'PATCH',
          body: {
            name: 'Renamed',
            entries: [gateway(FLASH)],
            defaultEntryKey: customRouterEntryKey(gateway(FLASH)),
          },
        }),
        params('user', 'coding')
      );

      expect(updated.status).toBe(200);
      expect(mockedBlocked).not.toHaveBeenCalled();
    });

    test('pauses the pool’s latest request before the delete commits', async () => {
      await create(routerBody());
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row).toBeDefined();
      mockedPoolPause.mockResolvedValueOnce({
        ok: true,
        body: {
          status: 'paused',
          id: '3f1c0c3e-1d15-4e3e-9d4a-32f6b0a1c111',
          estimateMicrodollars: 100,
          maximumMicrodollars: 200,
          chargedMicrodollars: 0,
          billedModelRequests: 0,
          kiloCoveredModelRequests: 0,
          kiloCoveredMicrodollars: 0,
          counts: { queued: 0, running: 0, reused: 0, done: 0, failed: 0, paused: 0 },
          cases: [],
          nextCursor: null,
          reason: null,
        },
      });

      const deleted = await deleteRouter(
        request('/user/coding', { method: 'DELETE' }),
        params('user', 'coding')
      );

      expect(deleted.status).toBe(204);
      // Pause by pool: the Worker resolves the latest request itself, so the web never reads
      // progress (which could stage the next plan) before stopping work.
      expect(mockedPoolPause).toHaveBeenCalledWith({
        ownerType: 'user',
        ownerId: user.id,
        routerId: row?.id,
      });
      expect(mockedBenchmarkProgress).not.toHaveBeenCalled();
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
    });

    test('refuses the delete when the running benchmark cannot be stopped', async () => {
      await create(routerBody());
      mockedPoolPause.mockResolvedValueOnce({
        ok: false,
        status: 502,
        error: {
          code: 'invalid_response',
          message: 'The benchmark worker returned an invalid response',
        },
      });

      const deleted = await errorOf(
        await deleteRouter(request('/user/coding', { method: 'DELETE' }), params('user', 'coding'))
      );

      expect(deleted).toMatchObject({
        status: 500,
        body: { error: { code: 'internal_error' } },
      });
      // Rolled back: the pool and everything in it are intact.
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(1);
    });

    test('deletes the pool when the deployed worker predates the paid path', async () => {
      await create(routerBody());
      mockedPoolPause.mockResolvedValueOnce({
        ok: false,
        status: 404,
        error: { code: null, message: 'Request failed: 404' },
      });

      const deleted = await deleteRouter(
        request('/user/coding', { method: 'DELETE' }),
        params('user', 'coding')
      );

      expect(deleted.status).toBe(204);
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
    });

    test('refuses a risky edit that removes a model while the running benchmark cannot be stopped', async () => {
      await create(routerBody({ entries: [gateway(SONNET), gateway(FLASH)] }));
      mockedPoolPause.mockResolvedValueOnce({
        ok: false,
        status: 502,
        error: {
          code: 'invalid_response',
          message: 'The benchmark worker returned an invalid response',
        },
      });

      const updated = await errorOf(
        await updateRouter(
          request('/user/coding', {
            method: 'PATCH',
            body: {
              entries: [gateway(SONNET)],
              defaultEntryKey: customRouterEntryKey(gateway(SONNET)),
            },
          }),
          params('user', 'coding')
        )
      );

      expect(updated).toMatchObject({
        status: 500,
        body: { error: { code: 'internal_error' } },
      });
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row?.entries).toEqual([gateway(SONNET), gateway(FLASH)]);
      expect(mockedPoolPause).toHaveBeenCalledTimes(1);
    });

    test('pauses before a base-router move and keeps the owner and link intact', async () => {
      const linked = { ...gateway(BYOK), measuredAs: SONNET };
      await create(
        routerBody({ entries: [linked], defaultEntryKey: customRouterEntryKey(linked) })
      );
      mockedPoolPause.mockResolvedValueOnce({
        ok: true,
        body: { status: 'empty' },
      });

      const updated = await updateRouter(
        request('/user/coding', { method: 'PATCH', body: { baseRouter: 'frontier' } }),
        params('user', 'coding')
      );

      expect(updated.status).toBe(200);
      expect(mockedPoolPause).toHaveBeenCalledTimes(1);
      const [row] = await db
        .select()
        .from(auto_routing_custom_routers)
        .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));
      expect(row).toMatchObject({ base_router: 'frontier' });
      expect(row?.entries).toEqual([linked]);
    });

    test('an add-only edit neither pauses nor starts work', async () => {
      await create(routerBody());
      mockedPoolPause.mockClear();

      const updated = await updateRouter(
        request('/user/coding', {
          method: 'PATCH',
          body: {
            entries: [gateway(SONNET), gateway(FLASH)],
            defaultEntryKey: customRouterEntryKey(gateway(SONNET)),
          },
        }),
        params('user', 'coding')
      );

      expect(updated.status).toBe(200);
      expect(mockedPoolPause).not.toHaveBeenCalled();
      expect(mockedRegister).not.toHaveBeenCalled();
      expect(mockedQuote).not.toHaveBeenCalled();
      expect(mockedStart).not.toHaveBeenCalled();
    });

    test('lists only personal routers outside an organization context', async () => {
      const organization = await createTestOrganization('Acme', user.id, 0);
      await create(routerBody());
      await create(
        routerBody({ scope: 'org', slug: 'team' }),
        `?organizationId=${organization.id}`
      );

      const listed = await list();

      expect(listed.status).toBe(200);
      expect(listed.body.routers.map(router => router.modelId)).toEqual([
        'kilo-auto/custom/coding',
      ]);
    });
  });

  test('persists custom mode, benchmark difficulty, and pool as independent settings', async () => {
    await create(routerBody({ slug: 'efficient' }));
    await db
      .update(auto_routing_custom_routers)
      .set({ legacy_pool: true, legacy_mode_inherited: true })
      .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));
    const customParams = params('user', 'efficient');

    const modeUpdate = await updateRouter(
      request('/user/efficient', { method: 'PATCH', body: { mode: 'best_accuracy' } }),
      customParams
    );
    expect(modeUpdate.status).toBe(200);
    const afterMode = (await modeUpdate.json()) as CustomRouterResponse;
    expect(afterMode.router.mode).toBe('best_accuracy');
    expect(afterMode.router.baseRouter).toBe('efficient');
    expect(afterMode.router.entries.map(entry => entry.entry)).toEqual([gateway(SONNET)]);

    const difficultyUpdate = await updateRouter(
      request('/user/efficient', { method: 'PATCH', body: { baseRouter: 'frontier' } }),
      customParams
    );
    expect(difficultyUpdate.status).toBe(200);
    const afterDifficulty = (await difficultyUpdate.json()) as CustomRouterResponse;
    expect(afterDifficulty.router.mode).toBe('best_accuracy');
    expect(afterDifficulty.router.baseRouter).toBe('frontier');
    expect(afterDifficulty.router.entries.map(entry => entry.entry)).toEqual([gateway(SONNET)]);

    const poolUpdate = await updateRouter(
      request('/user/efficient', {
        method: 'PATCH',
        body: {
          entries: [gateway(FLASH)],
          defaultEntryKey: customRouterEntryKey(gateway(FLASH)),
        },
      }),
      customParams
    );
    expect(poolUpdate.status).toBe(200);
    const reloaded = await getRouter(request('/user/efficient'), customParams);
    expect(reloaded.status).toBe(200);
    const afterPool = (await reloaded.json()) as CustomRouterResponse;
    expect(afterPool.router.mode).toBe('best_accuracy');
    expect(afterPool.router.baseRouter).toBe('frontier');
    expect(afterPool.router.entries.map(entry => entry.entry)).toEqual([gateway(FLASH)]);
    const [row] = await db
      .select()
      .from(auto_routing_custom_routers)
      .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));
    expect(row).toMatchObject({
      mode: 'best_accuracy',
      base_router: 'frontier',
      entries: [gateway(FLASH)],
      legacy_pool: true,
    });
  });

  test('persists the cheapest mode through the database check constraint', async () => {
    await create(routerBody({ slug: 'thrifty', mode: 'cheapest' }));
    const modeUpdate = await updateRouter(
      request('/user/thrifty', { method: 'PATCH', body: { mode: 'best_accuracy' } }),
      params('user', 'thrifty')
    );
    expect(modeUpdate.status).toBe(200);
    const backToCheapest = await updateRouter(
      request('/user/thrifty', { method: 'PATCH', body: { mode: 'cheapest' } }),
      params('user', 'thrifty')
    );
    expect(backToCheapest.status).toBe(200);
    const [row] = await db
      .select()
      .from(auto_routing_custom_routers)
      .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));
    expect(row).toMatchObject({ slug: 'thrifty', mode: 'cheapest' });
  });

  describe('linked entries', () => {
    test('rejects a link on a gateway entry the platform can serve', async () => {
      const entry = { ...gateway(FLASH), measuredAs: SONNET };
      const created = await create(
        routerBody({ entries: [entry], defaultEntryKey: customRouterEntryKey(entry) })
      );

      expect(created.status).toBe(400);
      expect(created.body).toMatchObject({
        error: {
          code: 'invalid_request',
          message: 'measuredAs is only for entries the platform cannot serve',
        },
      });
      expect(mockedGetPlatformMeasurements).not.toHaveBeenCalled();
      expect(mockedRegister).not.toHaveBeenCalled();
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
    });

    test.each(['gateway', 'client'] as const)(
      'accepts a listed platform measurement for a %s entry',
      async kind => {
        const entry = {
          ...(kind === 'gateway' ? gateway(BYOK) : clientEntry('local-sonnet')),
          measuredAs: SONNET,
        };
        const created = await create(
          routerBody({ entries: [entry], defaultEntryKey: customRouterEntryKey(entry) })
        );

        expect(created.status).toBe(201);
        expect(mockedGetPlatformMeasurements).toHaveBeenCalledWith('efficient');
        const [row] = await db.select().from(auto_routing_custom_routers);
        expect(row?.entries).toEqual([entry]);
      }
    );

    test('rejects a link absent from the platform measurements list before admission', async () => {
      const entry = { ...gateway(BYOK), measuredAs: DENIED };
      const created = await create(
        routerBody({ entries: [entry], defaultEntryKey: customRouterEntryKey(entry) })
      );

      expect(created.status).toBe(400);
      expect(created.body).toMatchObject({ error: { code: 'invalid_request' } });
      expect(mockedRegister).not.toHaveBeenCalled();
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
    });

    test('fails without admission or persistence when the measurements worker returns 5xx', async () => {
      mockedGetPlatformMeasurements.mockResolvedValue({
        status: 503,
        body: { error: 'Measurements unavailable' },
      });
      const entry = { ...gateway(BYOK), measuredAs: SONNET };
      const created = await create(
        routerBody({ entries: [entry], defaultEntryKey: customRouterEntryKey(entry) })
      );

      expect(created.status).toBe(500);
      expect(created.body).toMatchObject({ error: { code: 'internal_error' } });
      expect(mockedRegister).not.toHaveBeenCalled();
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
    });

    test('does not admit a linked gateway entry for platform inference', async () => {
      const entry = { ...gateway(BYOK), measuredAs: SONNET };
      const created = await create(
        routerBody({ entries: [entry], defaultEntryKey: customRouterEntryKey(entry) })
      );

      expect(created.status).toBe(201);
      expect(mockedRegister).not.toHaveBeenCalled();
    });

    test('preserves an unchanged link when its model disappears from measurements', async () => {
      const entry = { ...gateway(BYOK), measuredAs: SONNET };
      await create(routerBody({ entries: [entry], defaultEntryKey: customRouterEntryKey(entry) }));
      mockedGetPlatformMeasurements.mockClear();
      mockedGetPlatformMeasurements.mockResolvedValue({
        status: 200,
        body: { baseRouter: 'efficient', models: [] },
      });
      const added = clientEntry('local-model');
      const response = await updateRouter(
        request('/user/coding', {
          method: 'PATCH',
          body: { entries: [entry, added], defaultEntryKey: customRouterEntryKey(entry) },
        }),
        params('user', 'coding')
      );

      expect(response.status).toBe(200);
      expect(mockedGetPlatformMeasurements).not.toHaveBeenCalled();
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row?.entries).toEqual([entry, added]);
    });

    test('revalidates existing links when the benchmark base changes', async () => {
      const entry = { ...gateway(BYOK), measuredAs: SONNET };
      await create(routerBody({ entries: [entry], defaultEntryKey: customRouterEntryKey(entry) }));
      mockedGetPlatformMeasurements.mockClear();
      mockedGetPlatformMeasurements.mockResolvedValue({
        status: 200,
        body: { baseRouter: 'frontier', models: [] },
      });
      const response = await updateRouter(
        request('/user/coding', { method: 'PATCH', body: { baseRouter: 'frontier' } }),
        params('user', 'coding')
      );

      expect(response.status).toBe(400);
      expect(mockedGetPlatformMeasurements).toHaveBeenCalledWith('frontier');
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row?.base_router).toBe('efficient');
    });

    test('persists an update that changes only the measurement link', async () => {
      await create(routerBody({ entries: [gateway(BYOK)], defaultEntryKey: `gateway:${BYOK}` }));
      mockedRegister.mockClear();
      const entry = { ...gateway(BYOK), measuredAs: SONNET };
      const response = await updateRouter(
        request('/user/coding', {
          method: 'PATCH',
          body: { entries: [entry], defaultEntryKey: customRouterEntryKey(entry) },
        }),
        params('user', 'coding')
      );

      expect(response.status).toBe(200);
      const summary = ((await response.json()) as CustomRouterResponse).router;
      expect(summary.entries.map(item => item.entry)).toEqual([entry]);
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row?.entries).toEqual([entry]);
      expect(mockedRegister).not.toHaveBeenCalled();
    });
  });
  describe('validation and limits', () => {
    test.each([
      ['the reserved org slug', routerBody({ slug: 'org' })],
      ['an invalid slug', routerBody({ slug: 'Not-Valid-' })],
      [
        'a default entry outside the pool',
        routerBody({ defaultEntryKey: customRouterEntryKey(gateway(FLASH)) }),
      ],
      ['duplicate entries', routerBody({ entries: [gateway(SONNET), gateway(SONNET)] })],
      [
        'more than 20 entries',
        routerBody({
          entries: Array.from({ length: 21 }, (_, index) => clientEntry(`model-${index}`)),
          defaultEntryKey: customRouterEntryKey(clientEntry('model-0')),
        }),
      ],
      [
        'an unknown gateway model',
        routerBody({
          entries: [gateway('vendor/unknown')],
          defaultEntryKey: customRouterEntryKey(gateway('vendor/unknown')),
        }),
      ],
      [
        'an auto router as a pool member',
        routerBody({
          entries: [gateway('kilo-auto/frontier')],
          defaultEntryKey: customRouterEntryKey(gateway('kilo-auto/frontier')),
        }),
      ],
    ])('rejects %s', async (_label, body) => {
      const created = await create(body);

      expect(created.status).toBe(400);
      expect(created.body).toMatchObject({ error: { code: 'invalid_request' } });
      expect(mockedRegister).not.toHaveBeenCalled();
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
    });

    test('rejects an oversized client entry before admission and storage', async () => {
      const base = clientEntry('qwen3:32b');
      const oversized = [
        clientEntry('m'.repeat(MAX_CUSTOM_ROUTER_MODEL_ID_LENGTH + 1)),
        {
          ...base,
          variants: Array.from({ length: MAX_CLIENT_VARIANTS + 1 }, (_, index) => `v${index}`),
        },
        {
          ...base,
          capabilities: { ...base.capabilities, contextLength: MAX_CLIENT_CONTEXT_LENGTH + 1 },
        },
        {
          ...base,
          pricing: { inputPerMTokUsd: Number.POSITIVE_INFINITY, outputPerMTokUsd: 0 },
        },
      ];

      for (const entry of oversized) {
        const created = await create(
          routerBody({ entries: [entry], defaultEntryKey: customRouterEntryKey(entry) })
        );

        expect(created.status).toBe(400);
        expect(created.body).toMatchObject({ error: { code: 'invalid_request' } });
      }
      expect(mockedRegister).not.toHaveBeenCalled();
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
    });

    test.each(['create', 'update'] as const)(
      'rejects a %s body over the byte limit',
      async route => {
        if (route === 'update') await create(routerBody());
        mockedRegister.mockClear();
        const padding = 'x'.repeat(MAX_CUSTOM_ROUTER_BODY_BYTES + 1);

        const result =
          route === 'create'
            ? await create(routerBody({ padding }))
            : await errorOf(
                await updateRouter(
                  request('/user/coding', { method: 'PATCH', body: { padding } }),
                  params('user', 'coding')
                )
              );

        expect(result.status).toBe(400);
        expect(result.body).toMatchObject({
          error: {
            code: 'invalid_request',
            message: `Request body must be at most ${MAX_CUSTOM_ROUTER_BODY_BYTES} bytes`,
          },
        });
        expect(mockedRegister).not.toHaveBeenCalled();
        const rows = await db.select().from(auto_routing_custom_routers);
        expect(rows.map(row => row.name)).toEqual(route === 'update' ? ['Coding'] : []);
      }
    );

    test('accepts a body whose entries sit at every bound', async () => {
      const fill = (units: number, index: number) =>
        `${'a'.repeat(units - 2)}${index.toString().padStart(2, '0')}`;
      const entries = Array.from({ length: 20 }, (_, index) => ({
        kind: 'client' as const,
        provider: fill(100, index),
        model: fill(200, index),
        variants: Array.from({ length: 20 }, (_, variant) => fill(100, variant)),
        capabilities: {
          contextLength: 10_000_000,
          inputModalities: Array.from({ length: 10 }, (_, modality) => fill(50, modality)),
          toolCall: true,
          reasoning: true,
        },
        pricing: {
          inputPerMTokUsd: 1_000_000,
          outputPerMTokUsd: 1_000_000,
          cacheReadPerMTokUsd: 1_000_000,
        },
      }));
      const body = routerBody({
        slug: 'wide-chars',
        entries,
        defaultEntryKey: customRouterEntryKey(entries[0]),
      });

      expect(Buffer.byteLength(JSON.stringify(body))).toBeGreaterThan(60 * 1024);

      const created = await create(body);

      expect(created.status).toBe(201);
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(1);
    });

    test('maps an unreadable request body to invalid_request', async () => {
      const broken = request('', { method: 'POST', body: {} });
      Object.defineProperty(broken, 'body', {
        value: new ReadableStream({
          pull(controller) {
            controller.error(new Error('socket hang up'));
          },
        }),
      });

      const result = await errorOf(await createRouter(broken));

      expect(result).toEqual({
        status: 400,
        body: { error: expect.objectContaining({ code: 'invalid_request' }) },
      });
    });

    test('rejects a duplicate slug and an eleventh router for one owner', async () => {
      for (let index = 0; index < 10; index++) {
        expect((await create(routerBody({ slug: `router-${index}` }))).status).toBe(201);
      }

      const duplicate = await create(routerBody({ slug: 'router-0' }));
      const eleventh = await create(routerBody({ slug: 'router-10' }));

      expect(duplicate.status).toBe(400);
      expect(eleventh.status).toBe(400);
      expect(eleventh.body).toMatchObject({
        error: { code: 'invalid_request', message: expect.stringContaining('at most 10') },
      });
      expect(mockedRegister).not.toHaveBeenCalled();
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(10);
    });

    test('an update must keep the default entry inside the pool', async () => {
      await create(routerBody({ entries: [gateway(SONNET), gateway(FLASH)] }));

      const entriesOnly = await errorOf(
        await updateRouter(
          request('/user/coding', { method: 'PATCH', body: { entries: [gateway(FLASH)] } }),
          params('user', 'coding')
        )
      );
      const defaultOutsidePool = await errorOf(
        await updateRouter(
          request('/user/coding', {
            method: 'PATCH',
            body: { defaultEntryKey: customRouterEntryKey(gateway(DENIED)) },
          }),
          params('user', 'coding')
        )
      );
      const unknownModel = await errorOf(
        await updateRouter(
          request('/user/coding', {
            method: 'PATCH',
            body: {
              baseRouter: 'frontier',
              entries: [gateway('vendor/unknown')],
              defaultEntryKey: customRouterEntryKey(gateway('vendor/unknown')),
            },
          }),
          params('user', 'coding')
        )
      );
      expect(entriesOnly.status).toBe(400);
      expect(defaultOutsidePool.status).toBe(400);
      expect(unknownModel.status).toBe(400);
      expect(mockedRegister).not.toHaveBeenCalled();
      const moved = await updateRouter(
        request('/user/coding', {
          method: 'PATCH',
          body: {
            entries: [gateway(FLASH)],
            defaultEntryKey: customRouterEntryKey(gateway(FLASH)),
          },
        }),
        params('user', 'coding')
      );

      expect(entriesOnly.status).toBe(400);
      expect(defaultOutsidePool.status).toBe(400);
      expect(unknownModel.status).toBe(400);
      expect(moved.status).toBe(200);
      expect(mockedRegister).not.toHaveBeenCalled();
      const { router } = (await moved.json()) as CustomRouterResponse;
      expect(router.defaultEntryKey).toBe(customRouterEntryKey(gateway(FLASH)));
      expect(router.entries.map(entry => entry.key)).toEqual([
        customRouterEntryKey(gateway(FLASH)),
      ]);
    });
  });

  describe('concurrent saves', () => {
    test.each(['duplicate slug', 'last owner slot'])(
      'persists one router when concurrent creates collide on the %s',
      async race => {
        if (race === 'last owner slot') {
          for (let index = 0; index < 9; index++) {
            expect((await create(routerBody({ slug: `router-${index}` }))).status).toBe(201);
          }
        }
        const catalogReady = Promise.withResolvers<void>();
        const releaseCatalog = Promise.withResolvers<void>();
        let catalogRequests = 0;
        mockedGetEnhanced.mockImplementation(async () => {
          if (++catalogRequests === 2) catalogReady.resolve();
          await releaseCatalog.promise;
          return { data: [model(SONNET), model(FLASH)] };
        });

        const pending = Promise.all([
          create(routerBody({ slug: 'contender' })),
          create(
            routerBody({
              slug: race === 'duplicate slug' ? 'contender' : 'other-contender',
              entries: [gateway(FLASH)],
              defaultEntryKey: customRouterEntryKey(gateway(FLASH)),
            })
          ),
        ]);
        await catalogReady.promise;
        releaseCatalog.resolve();
        const results = await pending;

        expect(results.map(result => result.status).sort()).toEqual([201, 400]);
        // A save never admits platform benchmarks, so the losing save cannot have spent anything.
        expect(mockedRegister).not.toHaveBeenCalled();
        expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(
          race === 'duplicate slug' ? 1 : 10
        );
      }
    );

    test('keeps one saved pool when two updates race on the owner lock', async () => {
      await create(routerBody({ entries: [gateway(SONNET), gateway(FLASH)] }));

      const rename = updateRouter(
        request('/user/coding', { method: 'PATCH', body: { name: 'Renamed' } }),
        params('user', 'coding')
      );
      const baseChange = updateRouter(
        request('/user/coding', { method: 'PATCH', body: { baseRouter: 'frontier' } }),
        params('user', 'coding')
      );
      const results = await Promise.all([rename, baseChange]);

      expect(results.map(result => result.status)).toEqual([200, 200]);
      // Neither racing save admitted platform benchmarks or requested an estimate.
      expect(mockedRegister).not.toHaveBeenCalled();
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row).toMatchObject({
        name: 'Renamed',
        base_router: 'frontier',
        entries: [gateway(SONNET), gateway(FLASH)],
      });
    });

    test('rejects a save whose router was deleted while it waited for the lock', async () => {
      await create(routerBody({ entries: [gateway(SONNET), gateway(FLASH)] }));
      const removed = await deleteRouter(
        request('/user/coding', { method: 'DELETE' }),
        params('user', 'coding')
      );
      expect(removed.status).toBe(204);

      const updated = await updateRouter(
        request('/user/coding', { method: 'PATCH', body: { baseRouter: 'frontier' } }),
        params('user', 'coding')
      );

      expect(await errorOf(updated)).toMatchObject({
        status: 404,
        body: { error: { code: 'router_not_found' } },
      });
      // A delete previews and pauses the pool's request and never starts work.
      expect(mockedRegister).not.toHaveBeenCalled();
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
    });
  });

  describe('organization routers', () => {
    async function organizationWithMember(role: 'member' | 'billing_manager') {
      const organization = await createTestOrganization('Acme', user.id, 0);
      const member = await insertTestUser();
      await db.insert(organization_memberships).values({
        organization_id: organization.id,
        kilo_user_id: member.id,
        role,
      });
      await create(
        routerBody({ scope: 'org', slug: 'team' }),
        `?organizationId=${organization.id}`
      );
      return { organization, member };
    }

    test('an org scope without an organization context is router_not_found', async () => {
      const created = await create(routerBody({ scope: 'org', slug: 'team' }));

      expect(created.status).toBe(404);
      expect(created.body).toMatchObject({ error: { code: 'router_not_found' } });
    });

    test('lists personal and organization routers in the organization header context', async () => {
      const { organization } = await organizationWithMember('member');
      await create(routerBody());
      signIn(user, organization.id);

      const listed = await list();

      expect(listed.status).toBe(200);
      expect(listed.body.routers.map(router => [router.modelId, router.canEdit])).toEqual([
        ['kilo-auto/custom/org/team', true],
        ['kilo-auto/custom/coding', true],
      ]);
    });

    test('a member reads organization routers without edit rights and cannot mutate them', async () => {
      const { organization, member } = await organizationWithMember('member');
      signIn(member, organization.id);

      const listed = await list();
      const updated = await errorOf(
        await updateRouter(
          request('/org/team', { method: 'PATCH', body: { name: 'Renamed' } }),
          params('org', 'team')
        )
      );
      const deleted = await errorOf(
        await deleteRouter(request('/org/team', { method: 'DELETE' }), params('org', 'team'))
      );
      const registered = await errorOf(
        await registerClientEntry(
          request('/org/team/client-entries', {
            method: 'POST',
            body: { entry: clientEntry('qwen3:8b') },
          }),
          params('org', 'team')
        )
      );
      const createdByMember = await create(routerBody({ scope: 'org', slug: 'mine' }));

      expect(listed.body.routers).toEqual([
        expect.objectContaining({ modelId: 'kilo-auto/custom/org/team', canEdit: false }),
      ]);
      expect([updated.status, deleted.status, registered.status, createdByMember.status]).toEqual([
        403, 403, 403, 403,
      ]);
      expect(updated.body.error.code).toBe('forbidden');
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row?.name).toBe('Coding');
    });

    test('a billing manager edits organization routers', async () => {
      const { organization, member } = await organizationWithMember('billing_manager');
      signIn(member, organization.id);

      const updated = await updateRouter(
        request('/org/team', { method: 'PATCH', body: { name: 'Renamed' } }),
        params('org', 'team')
      );

      expect(updated.status).toBe(200);
      expect(((await updated.json()) as CustomRouterResponse).router).toMatchObject({
        name: 'Renamed',
        canEdit: true,
      });
    });

    test('a non-member cannot use the organization context', async () => {
      const { organization } = await organizationWithMember('member');
      signIn(await insertTestUser());

      const listed = await errorOf(
        await listRouters(request(`?organizationId=${organization.id}`))
      );

      expect(listed.status).toBe(403);
      expect(listed.body.error.code).toBe('forbidden');
    });

    test('rejects gateway models denied by organization policy', async () => {
      const organization = await createTestOrganization('Acme', user.id, 0);

      const created = await create(
        routerBody({
          scope: 'org',
          slug: 'team',
          entries: [gateway(DENIED)],
          defaultEntryKey: customRouterEntryKey(gateway(DENIED)),
        }),
        `?organizationId=${organization.id}`
      );

      expect(created.status).toBe(400);
      expect(created.body).toMatchObject({
        error: { message: expect.stringContaining('not allowed for the organization') },
      });
    });

    test('an expired organization cannot edit routers', async () => {
      const organization = await createTestOrganization('Acme', user.id, 0);
      mockedRequireActiveSubscription.mockRejectedValue(
        new TRPCError({ code: 'FORBIDDEN', message: 'Organization trial has expired.' })
      );

      const created = await create(
        routerBody({ scope: 'org', slug: 'team' }),
        `?organizationId=${organization.id}`
      );

      expect(created.status).toBe(403);
    });
  });

  describe('entry status', () => {
    test('derives needsClientEval from client-eval entries without a current ready result', async () => {
      const ready = clientEntry('ready-model', ['high', 'low']);
      const stale = clientEntry('stale-model');
      const partial = clientEntry('partial-model', ['high', 'low']);
      const entries = [gateway(SONNET), gateway(BYOK), ready, stale, partial];
      await create(routerBody({ entries }));
      const statusByKey = new Map<string, CustomRouterVariantStatus[]>([
        [customRouterEntryKey(gateway(SONNET)), variants(['pending'])],
        [customRouterEntryKey(gateway(BYOK)), variants(['failed'])],
        [customRouterEntryKey(ready), variants(['ready', 'ready'])],
        [customRouterEntryKey(stale), variants(['stale'])],
        [customRouterEntryKey(partial), variants(['ready', 'missing'])],
      ]);
      mockedGetStatus.mockImplementation(async request => ({
        status: 200,
        body: {
          entries: request.entries.map(entry => ({
            key: customRouterEntryKey(entry),
            variants: statusByKey.get(customRouterEntryKey(entry)) ?? [],
          })),
        },
      }));

      const listed = await list();

      expect(mockedGetStatus).toHaveBeenLastCalledWith({
        ownerType: 'user',
        ownerId: user.id,
        baseRouter: 'efficient',
        entries,
        clientEvalEntryKeys: [gateway(BYOK), ready, stale, partial].map(customRouterEntryKey),
      });
      expect(
        listed.body.routers[0]?.entries.map(entry => [
          entry.key,
          entry.needsClientEval,
          entry.variants,
        ])
      ).toEqual([
        [customRouterEntryKey(gateway(SONNET)), false, variants(['pending'])],
        [customRouterEntryKey(gateway(BYOK)), true, variants(['failed'])],
        [customRouterEntryKey(ready), false, variants(['ready', 'ready'])],
        [customRouterEntryKey(stale), true, variants(['stale'])],
        [customRouterEntryKey(partial), true, variants(['ready', 'missing'])],
      ]);
    });

    test('keeps listing routers when the status service fails', async () => {
      const local = clientEntry('qwen3:8b');
      await create(routerBody({ entries: [gateway(SONNET), local] }));
      mockedGetStatus.mockRejectedValue(new Error('benchmark worker down'));

      const listed = await list();

      expect(listed.status).toBe(200);
      expect(
        listed.body.routers[0]?.entries.map(entry => [entry.needsClientEval, entry.variants])
      ).toEqual([
        [false, []],
        [true, []],
      ]);
    });
  });

  describe('client entries', () => {
    test('registers, replaces, and removes client entries for the CLI', async () => {
      await create(routerBody());
      const local = clientEntry('qwen3:8b');
      const register = (entry: ClientCustomRouterEntry) =>
        registerClientEntry(
          request('/user/coding/client-entries', { method: 'POST', body: { entry } }),
          params('user', 'coding')
        );

      expect((await register(local)).status).toBe(200);
      const replaced = await register({ ...local, variants: ['think'] });
      const removed = await removeClientEntry(
        request('/user/coding/client-entries?provider=ollama&model=qwen3%3A8b', {
          method: 'DELETE',
        }),
        params('user', 'coding')
      );

      const replacedRouter = ((await replaced.json()) as CustomRouterResponse).router;
      expect(replacedRouter.entries.map(entry => entry.entry)).toEqual([
        gateway(SONNET),
        { ...local, variants: ['think'] },
      ]);
      // A client entry is measured by the owner's CLI; the save never enrolls platform benchmarks.
      expect(mockedRegister).not.toHaveBeenCalled();
      expect(removed.status).toBe(200);
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row?.entries).toEqual([gateway(SONNET)]);
    });

    test('keeps a stored link when the CLI re-registers the entry without one', async () => {
      const linked = { ...clientEntry('qwen3:8b'), measuredAs: SONNET };
      await create(
        routerBody({ entries: [linked], defaultEntryKey: customRouterEntryKey(linked) })
      );
      mockedGetPlatformMeasurements.mockClear();
      const { measuredAs: _link, ...unlinked } = linked;

      const response = await registerClientEntry(
        request('/user/coding/client-entries', {
          method: 'POST',
          body: { entry: { ...unlinked, variants: ['think'] } },
        }),
        params('user', 'coding')
      );

      expect(response.status).toBe(200);
      expect(mockedGetPlatformMeasurements).not.toHaveBeenCalled();
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row?.entries).toEqual([{ ...linked, variants: ['think'] }]);
    });

    test('looks the link up before the owner lock, so no connection waits on it', async () => {
      await create(routerBody());
      const lookupStarted = Promise.withResolvers<void>();
      const releaseLookup = Promise.withResolvers<void>();
      mockedGetPlatformMeasurements.mockImplementationOnce(async () => {
        lookupStarted.resolve();
        await releaseLookup.promise;
        return {
          status: 200,
          body: { baseRouter: 'efficient', models: [{ model: SONNET, variants: [null] }] },
        };
      });
      const linked = { ...clientEntry('local-sonnet'), measuredAs: SONNET };

      const pending = registerClientEntry(
        request('/user/coding/client-entries', { method: 'POST', body: { entry: linked } }),
        params('user', 'coding')
      );
      await lookupStarted.promise;

      const lockWhileLookingUp = await probeOwnerLock(user);
      const [unwritten] = await db.select().from(auto_routing_custom_routers);
      releaseLookup.resolve();
      const response = await pending;

      expect(lockWhileLookingUp).toEqual({ free: true });
      expect(unwritten?.entries).toEqual([gateway(SONNET)]);
      expect(response.status).toBe(200);
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row?.entries).toEqual([gateway(SONNET), linked]);
    });

    test('refuses a link the benchmark difficulty changed away from during the lookup', async () => {
      await create(routerBody());
      const lookupStarted = Promise.withResolvers<void>();
      const releaseLookup = Promise.withResolvers<void>();
      mockedGetPlatformMeasurements.mockImplementationOnce(async () => {
        lookupStarted.resolve();
        await releaseLookup.promise;
        return {
          status: 200,
          body: { baseRouter: 'efficient', models: [{ model: SONNET, variants: [null] }] },
        };
      });
      const linked = { ...clientEntry('local-sonnet'), measuredAs: SONNET };

      const pending = registerClientEntry(
        request('/user/coding/client-entries', { method: 'POST', body: { entry: linked } }),
        params('user', 'coding')
      );
      await lookupStarted.promise;
      await db
        .update(auto_routing_custom_routers)
        .set({ base_router: 'frontier' })
        .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));
      releaseLookup.resolve();

      const refused = await errorOf(await pending);
      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        error: { code: 'invalid_request', message: expect.stringContaining('baseRouter') },
      });
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row?.base_router).toBe('frontier');
      expect(row?.entries).toEqual([gateway(SONNET)]);
    });

    test('rejects a registered link the platform has no measurement for', async () => {
      await create(routerBody());
      mockedGetPlatformMeasurements.mockResolvedValue({
        status: 200,
        body: { baseRouter: 'efficient', models: [] },
      });

      const refused = await errorOf(
        await registerClientEntry(
          request('/user/coding/client-entries', {
            method: 'POST',
            body: { entry: { ...clientEntry('local-sonnet'), measuredAs: SONNET } },
          }),
          params('user', 'coding')
        )
      );

      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({ error: { code: 'invalid_request' } });
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row?.entries).toEqual([gateway(SONNET)]);
    });

    test('refuses to remove the default entry and to exceed the entry cap', async () => {
      const local = clientEntry('qwen3:8b');
      const fullPool = Array.from({ length: 20 }, (_, index) => clientEntry(`model-${index}`));
      await create(routerBody({ entries: [local], defaultEntryKey: customRouterEntryKey(local) }));
      await create(
        routerBody({
          slug: 'full',
          entries: fullPool,
          defaultEntryKey: customRouterEntryKey(fullPool[0] ?? local),
        })
      );

      const removedDefault = await errorOf(
        await removeClientEntry(
          request('/user/coding/client-entries?provider=ollama&model=qwen3%3A8b', {
            method: 'DELETE',
          }),
          params('user', 'coding')
        )
      );
      const overCap = await errorOf(
        await registerClientEntry(
          request('/user/full/client-entries', { method: 'POST', body: { entry: local } }),
          params('user', 'full')
        )
      );

      expect(removedDefault.status).toBe(400);
      expect(overCap.status).toBe(400);
      const [full] = await db
        .select()
        .from(auto_routing_custom_routers)
        .where(eq(auto_routing_custom_routers.slug, 'full'));
      expect(full?.entries).toHaveLength(20);
    });
  });

  describe('staff without a membership', () => {
    const mockedStaffAuthority = jest.mocked(requireStaffAuthorityForRequest);
    let staff: User;
    let organizationId: string;

    beforeEach(async () => {
      const organization = await createTestOrganization('Staff routers', user.id, 0);
      organizationId = organization.id;
      staff = await insertTestUser({ is_admin: true });
      signIn(staff);
      mockedStaffAuthority.mockImplementation(async (_auth, params) =>
        staffStepUpRefusal(params, '/api/auto-routing/custom-routers')
      );
    });

    test('a list returns the staff guard session step-up refusal', async () => {
      const response = await listRouters(request(`?organizationId=${organizationId}`));

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: 'MFA_REQUIRED',
        stepUp: { actionClass: 'support_read', purpose: 'session', binding: null },
      });
    });

    test('a create returns the operation step-up refusal and stores no router', async () => {
      const response = await createRouter(
        request(`?organizationId=${organizationId}`, {
          method: 'POST',
          body: routerBody({ scope: 'org', slug: 'efficient' }),
        })
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        stepUp: {
          actionClass: 'support_write',
          binding: { method: 'post', targetKind: 'organization', targetId: organizationId },
        },
      });
      expect(await db.select().from(auto_routing_custom_routers)).toEqual([]);
    });

    test('staff who hold a real membership never reach the staff guard', async () => {
      await addUserToOrganization(organizationId, staff.id, 'member');

      expect((await list(`?organizationId=${organizationId}`)).status).toBe(200);
      expect(mockedStaffAuthority).not.toHaveBeenCalled();
    });
  });

  describe('organization admin bypass audit', () => {
    beforeEach(() => {
      // A Kilo admin outside the organization reaches the write only through
      // the shared staff guard; these tests start after it admitted them.
      jest.mocked(requireStaffAuthorityForRequest).mockImplementation(async auth => auth);
    });

    async function orgRouter() {
      const organization = await createTestOrganization('Audited', user.id, 0);
      await create(
        routerBody({ scope: 'org', slug: 'team' }),
        `?organizationId=${organization.id}`
      );
      return organization;
    }

    async function deleteOrgRouter(organizationId: string) {
      return deleteRouter(
        request(`/org/team?organizationId=${organizationId}`, { method: 'DELETE' }),
        params('org', 'team')
      );
    }

    test('a Kilo admin outside the organization records the delete', async () => {
      const organization = await orgRouter();
      const admin = await insertTestUser({ is_admin: true });
      signIn(admin);

      expect((await deleteOrgRouter(organization.id)).status).toBe(204);
      const rows = await db
        .select()
        .from(admin_action_audit_logs)
        .where(eq(admin_action_audit_logs.actor_id, admin.id));
      expect(rows).toEqual([
        expect.objectContaining({
          action: 'organization.custom_router.delete',
          outcome: 'success',
          target_type: 'organization',
          target_id: organization.id,
          metadata: { slug: 'team', heldRoles: [] },
        }),
      ]);
    });

    test('an organization owner deleting its own router records no admin row', async () => {
      const organization = await orgRouter();

      expect((await deleteOrgRouter(organization.id)).status).toBe(204);
      expect(await db.select().from(admin_action_audit_logs)).toEqual([]);
    });

    test('a Kilo admin outside the organization records a failed delete with its status', async () => {
      const organization = await createTestOrganization('Audited', user.id, 0);
      const admin = await insertTestUser({ is_admin: true });
      signIn(admin);

      expect((await deleteOrgRouter(organization.id)).status).toBe(404);
      const rows = await db
        .select()
        .from(admin_action_audit_logs)
        .where(eq(admin_action_audit_logs.actor_id, admin.id));
      expect(rows).toEqual([
        expect.objectContaining({
          action: 'organization.custom_router.delete',
          outcome: 'failure',
          target_type: 'organization',
          target_id: organization.id,
          metadata: { slug: 'team', heldRoles: [], errorCode: '404' },
        }),
      ]);
    });

    test('an organization owner whose delete fails records no admin row', async () => {
      const organization = await createTestOrganization('Audited', user.id, 0);

      expect((await deleteOrgRouter(organization.id)).status).toBe(404);
      expect(await db.select().from(admin_action_audit_logs)).toEqual([]);
    });
  });
});

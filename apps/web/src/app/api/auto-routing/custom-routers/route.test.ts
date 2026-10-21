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
  auto_routing_custom_routers,
  organization_memberships,
  organizations,
  type User,
} from '@kilocode/db/schema';
import {
  getCustomRouterStatus,
  registerOwnerBenchmarkProfiles,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client';
import {
  getDirectByokModelsForOrganization,
  getDirectByokModelsForUser,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import { getEnhancedOpenRouterModels } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { getAvailableModelsForOrganization } from '@kilocode/web-shared/lib/organizations/organization-models';
import { requireActiveSubscriptionOrTrial } from '@kilocode/web-shared/lib/organizations/trial-middleware';
import { isReleaseToggleEnabled } from '@kilocode/web-shared/lib/posthog-feature-flags';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { TRPCError } from '@trpc/server';
import { eq, inArray, sql } from 'drizzle-orm';
import { NextRequest, type NextResponse } from 'next/server';
import { lockOwner } from '@/lib/auto-routing-custom-routers';
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
jest.mock('@kilocode/web-shared/lib/posthog-feature-flags');
jest.mock('@kilocode/web-shared/lib/organizations/trial-middleware');
jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
  getCustomRouterStatus: jest.fn(),
  registerOwnerBenchmarkProfiles: jest.fn(),
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
const mockedIsReleaseToggleEnabled = jest.mocked(isReleaseToggleEnabled);
const mockedRequireActiveSubscription = jest.mocked(requireActiveSubscriptionOrTrial);
const mockedGetStatus = jest.mocked(getCustomRouterStatus);
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
  }));
}

function holdSecondCatalogRequest() {
  let calls = 0;
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  mockedGetEnhanced.mockImplementation(async () => {
    if (++calls === 2) {
      arrived.resolve();
      await release.promise;
    }
    return { data: [model(SONNET), model(FLASH), model(DENIED)] };
  });
  return { arrived: arrived.promise, release: release.resolve };
}

async function flushMicrotasks(turns = 10) {
  for (let turn = 0; turn < turns; turn++) await Promise.resolve();
}

describe('/api/auto-routing/custom-routers', () => {
  let user: User;

  beforeEach(async () => {
    jest.resetAllMocks();
    user = await insertTestUser();
    signIn(user);
    mockedIsReleaseToggleEnabled.mockResolvedValue(true);
    mockedRequireActiveSubscription.mockResolvedValue({ isReadOnly: false, daysRemaining: 30 });
    mockedRegister.mockResolvedValue({ ok: true });
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

  describe('feature flag', () => {
    test('a user without the flag gets router_not_found and cannot create routers', async () => {
      mockedIsReleaseToggleEnabled.mockResolvedValue(false);

      const listed = await errorOf(await listRouters(request('')));
      const created = await create(routerBody());

      expect(listed).toEqual({
        status: 404,
        body: { error: { code: 'router_not_found', message: expect.any(String) } },
      });
      expect(created.status).toBe(404);
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
      expect(mockedIsReleaseToggleEnabled).toHaveBeenCalledWith(
        'kilo-auto-custom-routers',
        user.id
      );
    });
  });

  describe('migrated owner pools', () => {
    test('an unflagged migrated owner can edit only the canonical router without creation access', async () => {
      await create(routerBody());
      await create(routerBody({ slug: 'efficient' }));
      await db
        .update(auto_routing_custom_routers)
        .set({ legacy_pool: true, legacy_mode_inherited: true })
        .where(eq(auto_routing_custom_routers.slug, 'efficient'));
      mockedIsReleaseToggleEnabled.mockResolvedValue(false);

      const listed = await list();
      expect(listed.body.canCreate).toBe(false);
      expect(listed.body.routers).toEqual([
        expect.objectContaining({ slug: 'efficient', legacyPool: true, canEdit: true }),
      ]);
      expect((await create(routerBody({ slug: 'another' }))).status).toBe(404);
      expect((await getRouter(request('/user/coding'), params('user', 'coding'))).status).toBe(404);
      const response = await updateRouter(
        request('/user/efficient', {
          method: 'PATCH',
          body: {
            name: 'Edited pool',
            mode: 'best_accuracy',
            entries: [gateway(FLASH)],
            defaultEntryKey: customRouterEntryKey(gateway(FLASH)),
          },
        }),
        params('user', 'efficient')
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as CustomRouterResponse).router).toMatchObject({
        slug: 'efficient',
        name: 'Edited pool',
        mode: 'best_accuracy',
        legacyPool: true,
        legacyModeInherited: false,
        defaultEntryKey: customRouterEntryKey(gateway(FLASH)),
      });
    });

    test('an entries-only custom edit preserves the preexisting inherited mode marker', async () => {
      await create(routerBody({ slug: 'efficient' }));
      await db
        .update(auto_routing_custom_routers)
        .set({
          legacy_pool: true,
          legacy_mode_inherited: true,
        })
        .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));

      const response = await updateRouter(
        request('/user/efficient', {
          method: 'PATCH',
          body: {
            entries: [gateway(FLASH)],
            defaultEntryKey: customRouterEntryKey(gateway(FLASH)),
          },
        }),
        params('user', 'efficient')
      );

      expect(response.status).toBe(200);
      expect(((await response.json()) as CustomRouterResponse).router).toMatchObject({
        legacyPool: true,
        legacyModeInherited: true,
      });
    });

    test('preserves the migrated slug and row while allowing benchmark difficulty edits', async () => {
      await create(routerBody({ slug: 'efficient' }));
      await db
        .update(auto_routing_custom_routers)
        .set({ legacy_pool: true })
        .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));

      expect(
        (
          await updateRouter(
            request('/user/efficient', {
              method: 'PATCH',
              body: { slug: 'renamed', name: 'Edited' },
            }),
            params('user', 'efficient')
          )
        ).status
      ).toBe(400);
      expect(
        (
          await updateRouter(
            request('/user/efficient', { method: 'PATCH', body: { baseRouter: 'frontier' } }),
            params('user', 'efficient')
          )
        ).status
      ).toBe(200);
      expect(
        (
          await deleteRouter(
            request('/user/efficient', { method: 'DELETE' }),
            params('user', 'efficient')
          )
        ).status
      ).toBe(400);
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row).toMatchObject({ slug: 'efficient', base_router: 'frontier', legacy_pool: true });
    });

    test.each(['member', 'billing_manager'] as const)(
      'an unflagged organization %s retains existing role permissions',
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
        mockedIsReleaseToggleEnabled.mockResolvedValue(false);
        signIn(member, organization.id);

        const listed = await list();
        expect(listed.body.routers).toEqual([
          expect.objectContaining({
            modelId: 'kilo-auto/custom/org/efficient',
            legacyPool: true,
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
      'an unflagged parent %s can discover and edit its child migrated router only',
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
        mockedIsReleaseToggleEnabled.mockResolvedValue(false);
        signIn(user, child.id);

        const listed = await list();
        expect(listed.status).toBe(200);
        expect(listed.body.canCreate).toBe(false);
        expect(listed.body.routers).toEqual([
          expect.objectContaining({
            modelId: 'kilo-auto/custom/org/efficient',
            legacyPool: true,
            canEdit: true,
          }),
        ]);
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
        expect((await create(routerBody({ scope: 'org', slug: 'new-router' }))).status).toBe(404);
        expect(
          (await getRouter(request('/org/unrelated-router'), params('org', 'unrelated-router')))
            .status
        ).toBe(404);
        expect(
          (
            await updateRouter(
              request('/org/unrelated-router', {
                method: 'PATCH',
                body: { name: 'Denied change' },
              }),
              params('org', 'unrelated-router')
            )
          ).status
        ).toBe(404);
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
      mockedIsReleaseToggleEnabled.mockResolvedValue(false);
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
      mockedIsReleaseToggleEnabled.mockResolvedValue(false);
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

    test('admits only platform-servable gateway entries for platform benchmarks', async () => {
      const entries = [gateway(SONNET), gateway(BYOK), clientEntry('qwen3:8b')];

      const created = await create(
        routerBody({
          baseRouter: 'frontier',
          entries,
          defaultEntryKey: customRouterEntryKey(entries[0]),
        })
      );

      expect(created.status).toBe(201);
      expect(mockedRegister).toHaveBeenCalledTimes(1);
      expect(mockedRegister).toHaveBeenCalledWith(
        {
          router: 'frontier',
          ownerType: 'user',
          ownerId: user.id,
          entries: [{ model: SONNET }],
        },
        expect.any(AbortSignal)
      );
    });

    test('uses one deadline across benchmark registration batches', async () => {
      const entries = Array.from({ length: 11 }, (_, index) => gateway(`vendor/model-${index}`));
      mockedGetEnhanced.mockResolvedValue({
        data: entries.map(entry => model(entry.model)),
      });

      const created = await create(
        routerBody({ entries, defaultEntryKey: customRouterEntryKey(entries[0]) })
      );

      expect(created.status).toBe(201);
      expect(mockedRegister).toHaveBeenCalledTimes(2);
      expect(
        mockedRegister.mock.calls.map(([registration]) => registration.entries.length)
      ).toEqual([10, 1]);
      const firstSignal = mockedRegister.mock.calls[0]?.[1];
      expect(firstSignal).toBeInstanceOf(AbortSignal);
      expect(mockedRegister.mock.calls[1]?.[1]).toBe(firstSignal);
    });

    test('fails the save when admission times out and releases the owner admission slot', async () => {
      const controller = new AbortController();
      const timeout = jest.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
      const admissionStarted = Promise.withResolvers<void>();
      mockedRegister.mockImplementationOnce(async (_registration, signal) => {
        if (!signal) throw new Error('Missing admission deadline');
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          admissionStarted.resolve();
        });
        return { ok: true };
      });

      try {
        const pending = create(routerBody());
        await admissionStarted.promise;
        controller.abort(new DOMException('Benchmark admission timed out', 'TimeoutError'));
        const created = await pending;

        expect(timeout).toHaveBeenCalledWith(10_000);
        expect(mockedRegister).toHaveBeenCalledTimes(1);
        expect(created.status).toBe(500);
        expect(created.body).toMatchObject({ error: { code: 'internal_error' } });
        expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
      } finally {
        timeout.mockRestore();
      }

      expect((await create(routerBody())).status).toBe(201);
    });

    test.each([
      [
        'a rejected request',
        () => mockedRegister.mockRejectedValueOnce(new TypeError('fetch failed')),
      ],
      [
        'a worker 503',
        () =>
          mockedRegister.mockResolvedValueOnce({
            ok: false,
            status: 503,
            error: { error: 'Service unavailable' },
          }),
      ],
    ])('retries %s once before saving', async (_failure, failOnce) => {
      failOnce();

      const created = await create(routerBody());

      expect(created.status).toBe(201);
      expect(mockedRegister).toHaveBeenCalledTimes(2);
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(1);
    });

    test('does not save when the registration retry also fails', async () => {
      mockedRegister.mockRejectedValue(new TypeError('fetch failed'));

      const created = await create(routerBody());

      expect(created.status).toBe(500);
      expect(created.body).toMatchObject({ error: { code: 'internal_error' } });
      expect(mockedRegister).toHaveBeenCalledTimes(2);
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
    });

    test('does not create the router when benchmark admission hits the owner quota', async () => {
      mockedRegister.mockResolvedValue({
        ok: false,
        status: 429,
        quota: { error: 'Benchmark limit reached.', retryAt: '2026-10-17T00:00:00.000Z' },
      });

      const created = await create(routerBody());

      expect(created.status).toBe(429);
      expect(created.body).toMatchObject({
        error: { code: 'quota_exceeded', retryAt: '2026-10-17T00:00:00.000Z' },
      });
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
    });

    test.each([
      'Custom profiles are only supported by the efficient router',
      'benchmark config not set: save it in the admin panel before registering profiles',
    ])('maps the benchmark worker rejection "%s" to a base router error', async message => {
      mockedRegister.mockResolvedValue({
        ok: false,
        status: 400,
        error: { error: message },
      });

      const created = await create(routerBody({ baseRouter: 'frontier' }));

      expect(created.status).toBe(400);
      expect(created.body).toMatchObject({
        error: {
          code: 'invalid_request',
          message: expect.stringContaining('frontier base router are not available yet'),
        },
      });
      expect(mockedRegister).toHaveBeenCalledWith(
        expect.objectContaining({ router: 'frontier' }),
        expect.any(AbortSignal)
      );
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
    });

    test('reports other benchmark worker failures as internal errors without saving', async () => {
      mockedRegister.mockResolvedValue({
        ok: false,
        status: 503,
        error: { error: 'Service unavailable' },
      });

      const created = await create(routerBody());

      expect(created.status).toBe(500);
      expect(created.body).toMatchObject({ error: { code: 'internal_error' } });
      expect(mockedRegister).toHaveBeenCalledTimes(2);
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
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
      'rejects an oversized %s body without admitting benchmarks',
      async route => {
        if (route === 'update') await create(routerBody());
        mockedRegister.mockClear();
        const oversizedName = 'x'.repeat(300 * 1024);

        const result =
          route === 'create'
            ? await create(routerBody({ name: oversizedName }))
            : await errorOf(
                await updateRouter(
                  request('/user/coding', {
                    method: 'PATCH',
                    body: { name: oversizedName },
                  }),
                  params('user', 'coding')
                )
              );

        expect(result.status).toBe(400);
        expect(result.body).toMatchObject({ error: { code: 'invalid_request' } });
        expect(mockedRegister).not.toHaveBeenCalled();
        const rows = await db.select().from(auto_routing_custom_routers);
        expect(rows.map(row => row.name)).toEqual(route === 'update' ? ['Coding'] : []);
      }
    );

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
      expect(mockedRegister).toHaveBeenCalledTimes(10);
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
      expect(mockedRegister).toHaveBeenCalledTimes(1);
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
      expect(mockedRegister).toHaveBeenCalledTimes(2);
      const { router } = (await moved.json()) as CustomRouterResponse;
      expect(router.defaultEntryKey).toBe(customRouterEntryKey(gateway(FLASH)));
      expect(router.entries.map(entry => entry.key)).toEqual([
        customRouterEntryKey(gateway(FLASH)),
      ]);
    });
  });

  describe('concurrent admission', () => {
    test.each(['duplicate slug', 'last owner slot'])(
      'persists one router when concurrent creates collide on the %s',
      async race => {
        if (race === 'last owner slot') {
          for (let index = 0; index < 9; index++) {
            expect((await create(routerBody({ slug: `router-${index}` }))).status).toBe(201);
          }
        }
        mockedRegister.mockClear();
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
        const winner = results.find(result => result.status === 201);
        if (!winner) throw new Error('expected one create to win');
        const { router } = winner.body as CustomRouterResponse;
        expect(mockedRegister).toHaveBeenCalledWith(
          expect.objectContaining({
            router: router.baseRouter,
            entries: router.entries.map(({ entry }) =>
              entry.kind === 'gateway' ? { model: entry.model } : entry
            ),
          }),
          expect.any(AbortSignal)
        );
        expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(
          race === 'duplicate slug' ? 1 : 10
        );
      }
    );

    test('registers benchmarks before the owner lock, so no connection waits on it', async () => {
      const admissionStarted = Promise.withResolvers<void>();
      const releaseAdmission = Promise.withResolvers<void>();
      mockedRegister.mockImplementationOnce(async () => {
        admissionStarted.resolve();
        await releaseAdmission.promise;
        return { ok: true };
      });

      const pending = create(routerBody());
      await admissionStarted.promise;

      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
      await db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout = '500ms'`);
        await lockOwner(tx, { type: 'user', id: user.id });
      });

      releaseAdmission.resolve();
      expect((await pending).status).toBe(201);
    });

    test('admits one benchmark request at a time per owner', async () => {
      let active = 0;
      let maxActive = 0;
      const order: string[] = [];
      const admissionStarted = Promise.withResolvers<void>();
      const releaseAdmission = Promise.withResolvers<void>();
      mockedRegister.mockImplementation(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push('start');
        admissionStarted.resolve();
        if (order.length === 1) await releaseAdmission.promise;
        order.push('end');
        active -= 1;
        return { ok: true };
      });
      const secondCatalog = holdSecondCatalogRequest();

      const first = create(routerBody({ slug: 'one' }));
      await admissionStarted.promise;
      const second = create(routerBody({ slug: 'two' }));
      await secondCatalog.arrived;
      secondCatalog.release();
      await flushMicrotasks();

      expect(order).toEqual(['start']);

      releaseAdmission.resolve();
      const results = await Promise.all([first, second]);

      expect(results.map(result => result.status)).toEqual([201, 201]);
      expect(order).toEqual(['start', 'end', 'start', 'end']);
      expect(maxActive).toBe(1);
    });

    test('admits different owners independently', async () => {
      const organization = await createTestOrganization('Acme', user.id, 0);
      signIn(user, organization.id);
      const order: string[] = [];
      const admissionStarted = Promise.withResolvers<void>();
      const releaseAdmission = Promise.withResolvers<void>();
      mockedRegister.mockImplementation(async () => {
        order.push('start');
        admissionStarted.resolve();
        if (order.length === 1) await releaseAdmission.promise;
        order.push('end');
        return { ok: true };
      });
      const secondCatalog = holdSecondCatalogRequest();

      const personal = create(routerBody({ slug: 'personal' }));
      await admissionStarted.promise;
      const orgRouter = create(routerBody({ scope: 'org', slug: 'team' }));
      await secondCatalog.arrived;
      secondCatalog.release();
      await flushMicrotasks();

      expect(order.slice(0, 2)).toEqual(['start', 'start']);

      releaseAdmission.resolve();
      const results = await Promise.all([personal, orgRouter]);

      expect(results.map(result => result.status)).toEqual([201, 201]);
    });

    test('admits the latest locked base router when a concurrent update changes the pool', async () => {
      await create(routerBody());
      mockedRegister.mockClear();
      const admissionStarted = Promise.withResolvers<void>();
      const releaseAdmission = Promise.withResolvers<void>();
      mockedRegister.mockImplementationOnce(async () => {
        admissionStarted.resolve();
        await releaseAdmission.promise;
        return { ok: true };
      });
      const baseChange = updateRouter(
        request('/user/coding', { method: 'PATCH', body: { baseRouter: 'frontier' } }),
        params('user', 'coding')
      );
      await admissionStarted.promise;

      const catalogReady = Promise.withResolvers<void>();
      mockedGetEnhanced.mockImplementationOnce(async () => {
        catalogReady.resolve();
        return { data: [model(SONNET), model(FLASH)] };
      });
      const poolChange = updateRouter(
        request('/user/coding', {
          method: 'PATCH',
          body: {
            entries: [gateway(SONNET), gateway(FLASH)],
            defaultEntryKey: customRouterEntryKey(gateway(SONNET)),
          },
        }),
        params('user', 'coding')
      );
      await catalogReady.promise;
      releaseAdmission.resolve();
      const [baseResponse, poolResponse] = await Promise.all([baseChange, poolChange]);

      expect([baseResponse.status, poolResponse.status]).toEqual([200, 200]);
      expect(mockedRegister).toHaveBeenLastCalledWith(
        {
          router: 'frontier',
          ownerType: 'user',
          ownerId: user.id,
          entries: [{ model: SONNET }, { model: FLASH }],
        },
        expect.any(AbortSignal)
      );
      const [row] = await db.select().from(auto_routing_custom_routers);
      expect(row).toMatchObject({
        base_router: 'frontier',
        entries: [gateway(SONNET), gateway(FLASH)],
      });
    });

    test('rejects a save whose router was deleted after admission', async () => {
      await create(routerBody({ entries: [gateway(SONNET), gateway(FLASH)] }));
      mockedRegister.mockClear();
      const admissionStarted = Promise.withResolvers<void>();
      const releaseAdmission = Promise.withResolvers<void>();
      mockedRegister.mockImplementationOnce(async () => {
        admissionStarted.resolve();
        await releaseAdmission.promise;
        return { ok: true };
      });
      const pendingUpdate = updateRouter(
        request('/user/coding', { method: 'PATCH', body: { baseRouter: 'frontier' } }),
        params('user', 'coding')
      );
      await admissionStarted.promise;

      const removed = await deleteRouter(
        request('/user/coding', { method: 'DELETE' }),
        params('user', 'coding')
      );
      expect(removed.status).toBe(204);
      releaseAdmission.resolve();

      const updated = await pendingUpdate;
      expect(await errorOf(updated)).toMatchObject({
        status: 404,
        body: { error: { code: 'router_not_found' } },
      });
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
      expect(mockedRegister).toHaveBeenCalledTimes(1);
      expect(removed.status).toBe(200);
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
});

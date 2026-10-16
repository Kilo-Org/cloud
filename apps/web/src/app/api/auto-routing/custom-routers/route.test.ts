import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  customRouterEntryKey,
  type ClientCustomRouterEntry,
  type CustomRouterEntry,
  type CustomRouterListResponse,
  type CustomRouterResponse,
  type CustomRouterVariantStatus,
} from '@kilocode/auto-routing-contracts';
import {
  auto_routing_custom_routers,
  organization_memberships,
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
import { eq } from 'drizzle-orm';
import { NextRequest, type NextResponse } from 'next/server';
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
      expect(mockedRegister).toHaveBeenCalledWith({
        router: 'frontier',
        ownerType: 'user',
        ownerId: user.id,
        entries: [{ model: SONNET }],
      });
    });

    test('rolls back the router when benchmark admission hits the owner quota', async () => {
      mockedRegister.mockResolvedValue({
        ok: false,
        status: 429,
        quota: { error: 'Benchmark limit reached.', retryAt: '2026-10-17T00:00:00.000Z' },
      });

      const created = await create(routerBody());

      expect(created.status).toBe(429);
      expect(created.body).toMatchObject({
        error: { code: 'invalid_request' },
        retryAt: '2026-10-17T00:00:00.000Z',
      });
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
      expect(await db.select().from(auto_routing_custom_routers)).toHaveLength(0);
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
      expect(moved.status).toBe(200);
      const { router } = (await moved.json()) as CustomRouterResponse;
      expect(router.defaultEntryKey).toBe(customRouterEntryKey(gateway(FLASH)));
      expect(router.entries.map(entry => entry.key)).toEqual([
        customRouterEntryKey(gateway(FLASH)),
      ]);
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
      const entries = [gateway(SONNET), gateway(BYOK), ready, stale];
      await create(routerBody({ entries }));
      const statusByKey = new Map<string, CustomRouterVariantStatus[]>([
        [customRouterEntryKey(gateway(SONNET)), variants(['pending'])],
        [customRouterEntryKey(gateway(BYOK)), variants(['failed'])],
        [customRouterEntryKey(ready), variants(['ready', 'ready'])],
        [customRouterEntryKey(stale), variants(['stale'])],
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
        clientEvalEntryKeys: [gateway(BYOK), ready, stale].map(customRouterEntryKey),
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

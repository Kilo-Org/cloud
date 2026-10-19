import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  customRouterEntryKey,
  type AutoRoutingModeResponse,
} from '@kilocode/auto-routing-contracts';
import {
  auto_routing_custom_routers,
  organization_memberships,
  type User,
} from '@kilocode/db/schema';
import {
  getAutoRoutingMode,
  updateAutoRoutingMode,
} from '@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { requireActiveSubscriptionOrTrial } from '@kilocode/web-shared/lib/organizations/trial-middleware';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { GET, PUT } from './route';

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client');
jest.mock('@kilocode/web-shared/lib/organizations/trial-middleware');
jest.mock('@kilocode/web-shared/lib/user/server');

const mockedGetMode = jest.mocked(getAutoRoutingMode);
const mockedUpdateMode = jest.mocked(updateAutoRoutingMode);
const mockedRequireActiveSubscription = jest.mocked(requireActiveSubscriptionOrTrial);
const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);

function request(query = '', body?: unknown) {
  return new NextRequest(`http://localhost:3000/api/auto-routing/mode${query}`, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function signIn(user: User) {
  mockedGetUserFromAuth.mockResolvedValue({ user, authFailedResponse: null } as never);
}

describe('/api/auto-routing/mode', () => {
  let user: User;

  beforeEach(async () => {
    jest.resetAllMocks();
    user = await insertTestUser();
    signIn(user);
    mockedRequireActiveSubscription.mockResolvedValue({ isReadOnly: false, daysRemaining: 30 });
    mockedGetMode.mockImplementation(async owner => ({
      status: 200,
      body: {
        ...owner,
        mode: 'cost_per_accuracy',
        configuredMode: null,
        defaultMode: 'cost_per_accuracy',
      },
    }));
    mockedUpdateMode.mockImplementation(async ({ mode, ...owner }) => ({
      status: 200,
      body: {
        ...owner,
        mode: mode ?? 'cost_per_accuracy',
        configuredMode: mode,
        defaultMode: 'cost_per_accuracy',
      },
    }));
  });

  afterEach(async () => {
    await cleanupDbForTest();
  });

  test('requires authentication for reads and writes', async () => {
    mockedGetUserFromAuth.mockResolvedValue({ user: null, authFailedResponse: null } as never);
    expect((await GET(request())).status).toBe(401);
    expect((await PUT(request('', { mode: 'best_accuracy' }))).status).toBe(401);
    expect(mockedGetMode).not.toHaveBeenCalled();
    expect(mockedUpdateMode).not.toHaveBeenCalled();
  });

  test('reads the authenticated personal mode, ignoring caller-supplied owner fields', async () => {
    const body: AutoRoutingModeResponse = {
      ownerType: 'user',
      ownerId: user.id,
      mode: 'best_accuracy',
      configuredMode: 'best_accuracy',
      defaultMode: 'cost_per_accuracy',
    };
    mockedGetMode.mockResolvedValue({ status: 200, body });

    const response = await GET(request('?ownerType=org&ownerId=someone-else'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(body);
    expect(mockedGetMode).toHaveBeenCalledWith({ ownerType: 'user', ownerId: user.id });
  });

  test.each(['cost_per_accuracy', 'best_accuracy', null] as const)(
    'updates the authenticated personal mode to %s with null preserved as inheritance',
    async mode => {
      const response = await PUT(
        request('', { mode, ownerType: 'org', ownerId: 'someone-else', pool: [] })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ownerType: 'user',
        ownerId: user.id,
        mode: mode ?? 'cost_per_accuracy',
        configuredMode: mode,
      });
      expect(mockedUpdateMode).toHaveBeenCalledWith({ ownerType: 'user', ownerId: user.id, mode });
      expect(mockedRequireActiveSubscription).not.toHaveBeenCalled();
    }
  );

  test.each(['owner', 'admin', 'billing_manager'] as const)(
    'allows an organization %s to set and clear its mode',
    async role => {
      const organization = await createTestOrganization('Mode settings', user.id, 0);
      await db
        .update(organization_memberships)
        .set({ role })
        .where(eq(organization_memberships.kilo_user_id, user.id));
      const query = `?organizationId=${organization.id}`;

      for (const mode of ['best_accuracy', null] as const) {
        const response = await PUT(request(query, { mode }));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          ownerType: 'org',
          ownerId: organization.id,
          configuredMode: mode,
        });
        expect(mockedUpdateMode).toHaveBeenLastCalledWith({
          ownerType: 'org',
          ownerId: organization.id,
          mode,
        });
      }
      expect(mockedRequireActiveSubscription).toHaveBeenCalledWith(organization.id);
    }
  );

  test('lets ordinary members read organization modes but not change them', async () => {
    const organization = await createTestOrganization('Read-only mode', user.id, 0);
    const member = await insertTestUser();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: member.id,
      role: 'member',
    });
    signIn(member);
    const query = `?organizationId=${organization.id}`;

    expect((await GET(request(query))).status).toBe(200);
    expect(mockedGetMode).toHaveBeenCalledWith({ ownerType: 'org', ownerId: organization.id });
    expect((await PUT(request(query, { mode: 'best_accuracy' }))).status).toBe(401);
    expect((await PUT(request(query, { mode: null }))).status).toBe(401);
    expect(mockedUpdateMode).not.toHaveBeenCalled();
    expect(mockedRequireActiveSubscription).not.toHaveBeenCalled();
  });

  test('denies organization reads and writes to a nonmember', async () => {
    const organization = await createTestOrganization('Private mode', user.id, 0);
    signIn(await insertTestUser());
    const query = `?organizationId=${organization.id}`;

    expect((await GET(request(query))).status).toBe(401);
    expect((await PUT(request(query, { mode: 'best_accuracy' }))).status).toBe(401);
    expect(mockedGetMode).not.toHaveBeenCalled();
    expect(mockedUpdateMode).not.toHaveBeenCalled();
  });

  test('keeps expired organization settings readable while blocking writes', async () => {
    const organization = await createTestOrganization('Expired mode', user.id, 0);
    mockedRequireActiveSubscription.mockRejectedValue(
      new TRPCError({ code: 'FORBIDDEN', message: 'Organization trial has expired.' })
    );
    const query = `?organizationId=${organization.id}`;

    expect((await GET(request(query))).status).toBe(200);
    const response = await PUT(request(query, { mode: 'best_accuracy' }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'Organization trial has expired.' });
    expect(mockedUpdateMode).not.toHaveBeenCalled();
  });

  test.each([{}, { mode: 'fastest' }, { mode: false }, null])(
    'rejects invalid mode bodies without changing saved settings: %j',
    async body => {
      const response = await PUT(request('', body));
      expect(response.status).toBe(400);
      expect(mockedUpdateMode).not.toHaveBeenCalled();
    }
  );

  test('rejects malformed JSON', async () => {
    const response = await PUT(
      new NextRequest('http://localhost:3000/api/auto-routing/mode', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: '{',
      })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' });
    expect(mockedUpdateMode).not.toHaveBeenCalled();
  });

  test('returns worker write failures instead of reporting success', async () => {
    mockedUpdateMode.mockResolvedValue({
      status: 503,
      body: { error: 'Mode storage unavailable' },
    });
    const response = await PUT(request('', { mode: null }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'Mode storage unavailable' });
  });

  test('platform mode writes never change an independent custom router mode or pool', async () => {
    const entry = { kind: 'gateway' as const, model: 'anthropic/claude-sonnet-4' };
    const [saved] = await db
      .insert(auto_routing_custom_routers)
      .values({
        owned_by_user_id: user.id,
        created_by_user_id: user.id,
        slug: 'efficient',
        name: 'My router',
        base_router: 'frontier',
        mode: 'best_accuracy',
        entries: [entry],
        default_entry_key: customRouterEntryKey(entry),
        legacy_pool: true,
        legacy_mode_inherited: true,
      })
      .returning();
    expect(saved).toBeDefined();

    expect((await PUT(request('', { mode: 'cost_per_accuracy' }))).status).toBe(200);
    expect((await PUT(request('', { mode: null }))).status).toBe(200);
    const rows = await db
      .select()
      .from(auto_routing_custom_routers)
      .where(eq(auto_routing_custom_routers.owned_by_user_id, user.id));
    expect(rows).toEqual([saved]);
  });
});

jest.mock('@kilocode/web-shared/lib/auth/claude/feature-flag.server', () => ({
  isClaudePlatformOAuthEnabled: jest.fn(async () => true),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/claude-billing/operator', () => ({
  getClaudeOperatorToken: jest.fn(async () => 'router-operator-token'),
  isClaudeOperatorConfigured: jest.fn(() => false),
}));

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import {
  claude_billing_connection_grants,
  claude_billing_connections,
  organization_memberships,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { isClaudePlatformOAuthEnabled } from '@kilocode/web-shared/lib/auth/claude/feature-flag.server';
import { isClaudeOperatorConfigured } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { claudeBillingRouter } from './claude-billing-router';

const createCaller = createCallerFactory(claudeBillingRouter);

async function callerFor(userId: string) {
  const user = await findUserById(userId);
  if (!user) throw new Error('Missing user fixture');
  return createCaller({
    user,
    credential: 'session',
    authViaToken: false,
    webSessionId: 'router-test-session',
    webSessionPepper: user.web_session_pepper,
    headersList: new Headers(),
  });
}

async function seedConnectedPersonal(userId: string) {
  const [payer] = await db
    .insert(claude_billing_connections)
    .values({
      kilo_user_id: userId,
      user_profile_id: `uprof_${crypto.randomUUID()}`,
      connection_id: `ocon_${crypto.randomUUID()}`,
      status: 'connected',
      connected_at: new Date().toISOString(),
      created_by: userId,
    })
    .returning();
  if (!payer) throw new Error('Missing payer fixture');
  return payer;
}

beforeEach(() => {
  jest.mocked(isClaudePlatformOAuthEnabled).mockReset().mockResolvedValue(true);
  jest.mocked(isClaudeOperatorConfigured).mockReset().mockReturnValue(false);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('claudeBillingRouter.sharePersonal', () => {
  it('shares a connected personal payer with member and shared-services scopes', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Claude router share', user.id, 0);
    const payer = await seedConnectedPersonal(user.id);
    const caller = await callerFor(user.id);

    const memberStatus = await caller.sharePersonal({ organizationId: org.id });
    const sharedStatus = await caller.sharePersonal({
      organizationId: org.id,
      scope: 'shared_services',
    });

    expect(memberStatus).toMatchObject({ state: 'connected', canSharePersonal: false });
    expect(sharedStatus).toMatchObject({ state: 'connected', canSharePersonal: false });
    const grants = await db
      .select()
      .from(claude_billing_connection_grants)
      .where(eq(claude_billing_connection_grants.payer_connection_id, payer.id));
    expect(grants).toHaveLength(3);
  });

  it('forbids sharing to shared services when the caller is not an organization manager', async () => {
    const owner = await insertTestUser();
    const member = await insertTestUser();
    const org = await createTestOrganization('Claude router role', owner.id, 0);
    await db.insert(organization_memberships).values({
      organization_id: org.id,
      kilo_user_id: member.id,
      role: 'member',
    });
    await seedConnectedPersonal(member.id);
    const caller = await callerFor(member.id);

    await expect(
      caller.sharePersonal({ organizationId: org.id, scope: 'shared_services' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('forbids sharing when the release flag is off', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Claude router flag', user.id, 0);
    await seedConnectedPersonal(user.id);
    jest.mocked(isClaudePlatformOAuthEnabled).mockResolvedValue(false);
    const caller = await callerFor(user.id);

    await expect(caller.sharePersonal({ organizationId: org.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('returns CONFLICT when the target scope already uses another payer', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Claude router conflict', user.id, 0);
    await seedConnectedPersonal(user.id);
    await db.insert(claude_billing_connections).values({
      kilo_user_id: user.id,
      organization_id: org.id,
      user_profile_id: `uprof_${crypto.randomUUID()}`,
      connection_id: 'ocon_other',
      status: 'connected',
      connected_at: new Date().toISOString(),
      created_by: user.id,
    });
    const caller = await callerFor(user.id);

    await expect(caller.sharePersonal({ organizationId: org.id })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('forbids sharing over a bearer token outside a browser session', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Claude router bearer', user.id, 0);
    await seedConnectedPersonal(user.id);
    const bearerCaller = createCaller({
      user,
      credential: 'human_bearer',
      authViaToken: true,
      headersList: new Headers(),
    });

    await expect(bearerCaller.sharePersonal({ organizationId: org.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('claudeBillingRouter.share and multi-account flows', () => {
  it('shares an organization-linked payer to personal and another organization in any order', async () => {
    const user = await insertTestUser();
    const orgA = await createTestOrganization('Alpha Org', user.id, 0);
    const orgB = await createTestOrganization('Beta Org', user.id, 0);
    const [orgPayer] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: null,
        organization_id: orgA.id,
        user_profile_id: `uprof_${crypto.randomUUID()}`,
        connection_id: `ocon_${crypto.randomUUID()}`,
        status: 'connected',
        connected_at: new Date().toISOString(),
        created_by: user.id,
      })
      .returning();
    if (!orgPayer) throw new Error('Missing org payer fixture');
    const caller = await callerFor(user.id);

    const personalBefore = await caller.status({});
    expect(personalBefore).toMatchObject({
      state: 'not_connected',
      canSharePersonal: false,
      shareableLinks: [
        {
          payerId: orgPayer.id,
          source: { organizationId: orgA.id, scope: 'shared_services' },
          label: 'Alpha Org (shared services)',
        },
      ],
    });

    const personalAfter = await caller.share({
      source: { organizationId: orgA.id, scope: 'shared_services' },
      target: {},
    });
    expect(personalAfter).toMatchObject({
      state: 'connected',
      sharedWith: ['Alpha Org (shared services)'],
      shareableLinks: [],
    });

    const memberBAfter = await caller.share({
      source: {},
      target: { organizationId: orgB.id },
    });
    expect(memberBAfter).toMatchObject({
      state: 'connected',
      sharedWith: ['Personal account', 'Alpha Org (shared services)'],
    });
  });

  it('lists multiple distinct Claude accounts on an unlinked scope and retires only unshared profiles on remove', async () => {
    jest.mocked(isClaudeOperatorConfigured).mockReturnValue(true);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status: 200 })
      );

    const user = await insertTestUser();
    const org = await createTestOrganization('Multi Claude Org', user.id, 0);
    const personalPayer = await seedConnectedPersonal(user.id);
    const [workPayer] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: user.id,
        organization_id: org.id,
        user_profile_id: `uprof_work_${crypto.randomUUID()}`,
        connection_id: `ocon_work_${crypto.randomUUID()}`,
        status: 'connected',
        connected_at: new Date().toISOString(),
        created_by: user.id,
      })
      .returning();
    if (!workPayer) throw new Error('Missing work payer fixture');
    const caller = await callerFor(user.id);

    const sharedBefore = await caller.status({ organizationId: org.id, scope: 'shared_services' });
    expect(sharedBefore.shareableLinks.map(link => link.label)).toEqual([
      'Multi Claude Org (member)',
      'Personal account',
    ]);

    await caller.share({
      source: { organizationId: org.id },
      target: { organizationId: org.id, scope: 'shared_services' },
    });

    await caller.remove({ organizationId: org.id });
    expect(fetchMock).not.toHaveBeenCalled();

    await caller.remove({ organizationId: org.id, scope: 'shared_services' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(workPayer.user_profile_id);

    await caller.remove({});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(personalPayer.user_profile_id);
  });

  it('forbids another admin from sharing a shared-services payer they did not connect', async () => {
    const alice = await insertTestUser();
    const bob = await insertTestUser();
    const org = await createTestOrganization('Shared Guard Org', alice.id, 0);
    await db.insert(organization_memberships).values({
      organization_id: org.id,
      kilo_user_id: bob.id,
      role: 'admin',
    });
    await db.insert(claude_billing_connections).values({
      kilo_user_id: null,
      organization_id: org.id,
      user_profile_id: `uprof_${crypto.randomUUID()}`,
      connection_id: `ocon_${crypto.randomUUID()}`,
      status: 'connected',
      connected_at: new Date().toISOString(),
      created_by: alice.id,
    });
    const bobCaller = await callerFor(bob.id);

    await expect(
      bobCaller.share({
        source: { organizationId: org.id, scope: 'shared_services' },
        target: {},
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

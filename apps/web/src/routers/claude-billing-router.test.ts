jest.mock('@kilocode/web-shared/lib/ai-gateway/claude-billing/operator', () => ({
  getClaudeOperatorToken: jest.fn(async () => 'router-operator-token'),
  isClaudeOperatorConfigured: jest.fn(() => false),
  unlinkClaudeUserProfile: jest.fn(async () => ({ kind: 'unlinked', revokedConnectionIds: [] })),
}));

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import {
  claude_billing_connection_grants,
  claude_billing_connections,
  kilocode_users,
  organization_memberships,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import {
  isClaudeOperatorConfigured,
  unlinkClaudeUserProfile,
} from '@kilocode/web-shared/lib/ai-gateway/claude-billing/operator';
import { getClaudeBillingConnection } from '@kilocode/web-shared/lib/ai-gateway/claude-billing/store';
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

async function seedConnectedOrganization(organizationId: string, createdBy: string) {
  const [payer] = await db
    .insert(claude_billing_connections)
    .values({
      kilo_user_id: null,
      organization_id: organizationId,
      user_profile_id: `uprof_${crypto.randomUUID()}`,
      connection_id: `ocon_${crypto.randomUUID()}`,
      status: 'connected',
      connected_at: new Date().toISOString(),
      created_by: createdBy,
    })
    .returning();
  if (!payer) throw new Error('Missing organization payer fixture');
  return payer;
}

beforeEach(() => {
  jest.mocked(isClaudeOperatorConfigured).mockReset().mockReturnValue(false);
  jest
    .mocked(unlinkClaudeUserProfile)
    .mockReset()
    .mockResolvedValue({ kind: 'unlinked', revokedConnectionIds: [] });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('claudeBillingRouter.sharePersonal', () => {
  it('shares a connected personal payer with an organization', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Claude router share', user.id, 0);
    const payer = await seedConnectedPersonal(user.id);
    const caller = await callerFor(user.id);

    const status = await caller.sharePersonal({ organizationId: org.id });

    expect(status).toMatchObject({ state: 'connected', canSharePersonal: false });
    const grants = await db
      .select()
      .from(claude_billing_connection_grants)
      .where(eq(claude_billing_connection_grants.payer_connection_id, payer.id));
    expect(grants).toHaveLength(2);
  });

  it('forbids sharing to an organization when the caller is not an owner or admin', async () => {
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

    await expect(caller.sharePersonal({ organizationId: org.id })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('returns CONFLICT when the target scope already uses another payer', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('Claude router conflict', user.id, 0);
    await seedConnectedPersonal(user.id);
    await seedConnectedOrganization(org.id, user.id);
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
    const orgPayer = await seedConnectedOrganization(orgA.id, user.id);
    const caller = await callerFor(user.id);

    const personalBefore = await caller.status({});
    expect(personalBefore).toMatchObject({
      state: 'not_connected',
      canSharePersonal: false,
      shareableLinks: [
        {
          payerId: orgPayer.id,
          source: { organizationId: orgA.id },
          label: 'Alpha Org',
        },
      ],
    });

    const personalAfter = await caller.share({
      source: { organizationId: orgA.id },
      target: {},
    });
    expect(personalAfter).toMatchObject({
      state: 'connected',
      sharedWith: ['Alpha Org'],
      shareableLinks: [],
    });

    const orgBAfter = await caller.share({
      source: {},
      target: { organizationId: orgB.id },
    });
    expect(orgBAfter).toMatchObject({
      state: 'connected',
      sharedWith: ['Personal account', 'Alpha Org'],
    });
  });

  it('lists distinct Claude accounts on an unlinked organization and retires only unshared profiles on remove', async () => {
    jest.mocked(isClaudeOperatorConfigured).mockReturnValue(true);
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () => new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status: 200 })
      );

    const user = await insertTestUser();
    const linkedOrg = await createTestOrganization('Multi Claude Org', user.id, 0);
    const targetOrg = await createTestOrganization('Unlinked Claude Org', user.id, 0);
    const personalPayer = await seedConnectedPersonal(user.id);
    const organizationPayer = await seedConnectedOrganization(linkedOrg.id, user.id);
    const caller = await callerFor(user.id);

    const unlinked = await caller.status({ organizationId: targetOrg.id });
    expect(unlinked.shareableLinks.map(link => link.label)).toEqual([
      'Personal account',
      'Multi Claude Org',
    ]);

    await caller.share({ source: {}, target: { organizationId: targetOrg.id } });
    await caller.remove({ organizationId: targetOrg.id });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(unlinkClaudeUserProfile).not.toHaveBeenCalled();

    await caller.remove({});
    expect(jest.mocked(unlinkClaudeUserProfile).mock.calls).toEqual([
      [personalPayer.user_profile_id, 15_000],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(personalPayer.user_profile_id);

    await caller.remove({ organizationId: linkedOrg.id });
    expect(jest.mocked(unlinkClaudeUserProfile).mock.calls.map(call => call[0])).toEqual([
      personalPayer.user_profile_id,
      organizationPayer.user_profile_id,
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(organizationPayer.user_profile_id);
  });

  it('forbids another admin from sharing an organization payer they did not connect', async () => {
    const alice = await insertTestUser();
    const bob = await insertTestUser();
    const org = await createTestOrganization('Shared Guard Org', alice.id, 0);
    await db.insert(organization_memberships).values({
      organization_id: org.id,
      kilo_user_id: bob.id,
      role: 'admin',
    });
    await seedConnectedOrganization(org.id, alice.id);
    const bobCaller = await callerFor(bob.id);

    await expect(
      bobCaller.share({ source: { organizationId: org.id }, target: {} })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('claudeBillingRouter.remove', () => {
  async function connectedPersonalCaller() {
    jest.mocked(isClaudeOperatorConfigured).mockReturnValue(true);
    const user = await insertTestUser();
    const payer = await seedConnectedPersonal(user.id);
    return { user, payer, caller: await callerFor(user.id) };
  }

  it.each<[string[]]>([[['ocon_ended']], [[]]])(
    'removes the row after Anthropic ends the link (%j)',
    async revoked => {
      const { user, payer, caller } = await connectedPersonalCaller();
      jest
        .mocked(unlinkClaudeUserProfile)
        .mockResolvedValue({ kind: 'unlinked', revokedConnectionIds: revoked });
      const fetchMock = jest
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status: 200 })
        );

      const status = await caller.remove({});

      expect(status).toMatchObject({ state: 'not_connected' });
      expect(unlinkClaudeUserProfile).toHaveBeenCalledWith(payer.user_profile_id, 15_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(
        await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
      ).toBeNull();
    }
  );

  it('removes the row when Anthropic has no profile left to unlink', async () => {
    const { user, payer, caller } = await connectedPersonalCaller();
    jest.mocked(unlinkClaudeUserProfile).mockResolvedValue({ kind: 'missing' });
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ type: 'user_profile_deleted' }), { status: 200 })
      );

    const status = await caller.remove({});

    expect(status).toMatchObject({ state: 'not_connected' });
    expect(unlinkClaudeUserProfile).toHaveBeenCalledWith(payer.user_profile_id, 15_000);
    expect(await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })).toBeNull();
    expect(fetchMock).toHaveBeenCalled();
  });

  it('keeps the row and asks for a retry when Anthropic does not answer', async () => {
    const { user, payer, caller } = await connectedPersonalCaller();
    jest.mocked(unlinkClaudeUserProfile).mockResolvedValue({ kind: 'retry' });
    const fetchMock = jest.spyOn(globalThis, 'fetch');

    await expect(caller.remove({})).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({ status: 'connected', user_profile_id: payer.user_profile_id });
  });

  it('keeps the row and points at Claude Console when Anthropic refuses the unlink', async () => {
    const { user, payer, caller } = await connectedPersonalCaller();
    jest.mocked(unlinkClaudeUserProfile).mockResolvedValue({ kind: 'needs_console' });
    const fetchMock = jest.spyOn(globalThis, 'fetch');

    await expect(caller.remove({})).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await getClaudeBillingConnection({ kind: 'personal', kiloUserId: user.id })
    ).toMatchObject({ status: 'connected', user_profile_id: payer.user_profile_id });
  });
});

describe('claudeBillingRouter organization connector state', () => {
  async function seedOrganizationConnection(connectorId: string) {
    const org = await createTestOrganization('Shared Connector Org', connectorId, 0);
    const row = await seedConnectedOrganization(org.id, connectorId);
    await db.insert(claude_billing_connection_grants).values({
      payer_connection_id: row.id,
      kilo_user_id: null,
      organization_id: org.id,
      created_by: connectorId,
    });
    return { org, row };
  }

  /** A second manager of the organization, still live, who reads the row. */
  async function addManager(organizationId: string) {
    const manager = await insertTestUser();
    await db.insert(organization_memberships).values({
      organization_id: organizationId,
      kilo_user_id: manager.id,
      role: 'owner',
    });
    return manager;
  }

  /** The account lifecycle keeps the user row and anonymizes it in place. */
  async function eraseAccount(userId: string) {
    await db
      .update(kilocode_users)
      .set({
        google_user_email: `deleted+${userId}@deleted.invalid`,
        blocked_reason: `soft-deleted at ${new Date().toISOString()}`,
      })
      .where(eq(kilocode_users.id, userId));
  }

  it('reports reconnect_required for a connected organization row whose connector is gone', async () => {
    const connector = await insertTestUser();
    const { org } = await seedOrganizationConnection(connector.id);
    const manager = await addManager(org.id);
    await eraseAccount(connector.id);

    const status = await (await callerFor(manager.id)).status({ organizationId: org.id });

    expect(status).toMatchObject({ state: 'reconnect_required', canManage: true });
    expect(status.connectedAt).not.toBeNull();
  });

  it('keeps connected for a live connector and for a personal row', async () => {
    const connector = await insertTestUser();
    const { org } = await seedOrganizationConnection(connector.id);
    const organization = await (
      await callerFor(connector.id)
    ).status({
      organizationId: org.id,
    });

    const person = await insertTestUser();
    await seedConnectedPersonal(person.id);
    const personal = await (await callerFor(person.id)).status({});

    expect(organization).toMatchObject({ state: 'connected' });
    expect(personal).toMatchObject({ state: 'connected' });
  });

  it('reports a member without manage rights the same row state', async () => {
    const connector = await insertTestUser();
    const { org } = await seedOrganizationConnection(connector.id);
    const member = await insertTestUser();
    await db.insert(organization_memberships).values({
      organization_id: org.id,
      kilo_user_id: member.id,
      role: 'member',
    });
    await eraseAccount(connector.id);

    const status = await (await callerFor(member.id)).status({ organizationId: org.id });

    expect(status).toMatchObject({ state: 'reconnect_required', canManage: false });
  });

  it('keeps billing_unavailable ahead of the connector state', async () => {
    const connector = await insertTestUser();
    const { org, row } = await seedOrganizationConnection(connector.id);
    const manager = await addManager(org.id);
    await db
      .update(claude_billing_connections)
      .set({ status: 'billing_unavailable' })
      .where(eq(claude_billing_connections.id, row.id));
    await eraseAccount(connector.id);

    const status = await (await callerFor(manager.id)).status({ organizationId: org.id });

    expect(status).toMatchObject({ state: 'billing_unavailable' });
  });
});

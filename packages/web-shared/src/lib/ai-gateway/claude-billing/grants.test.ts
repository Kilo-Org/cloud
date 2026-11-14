import { describe, expect, it } from '@jest/globals';
import { and, eq, isNull } from 'drizzle-orm';
import {
  byok_api_keys,
  claude_billing_connection_grants,
  claude_billing_connections,
  organization_memberships,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  type ClaudeBillingShareError,
  describeClaudeBillingSharing,
  getGrantedClaudeBillingConnection,
  insertClaudeBillingProfile,
  removeClaudeBillingGrant,
  removeUserClaudeBillingGrants,
  shareClaudeBillingConnection,
  type ClaudeBillingOwner,
} from './store';

async function connectedPayer(userId: string, organizationId: string | null = null) {
  const [row] = await db
    .insert(claude_billing_connections)
    .values({
      kilo_user_id: userId,
      organization_id: organizationId,
      user_profile_id: `uprof_${crypto.randomUUID()}`,
      connection_id: `ocon_${crypto.randomUUID()}`,
      status: 'connected',
      connected_at: new Date().toISOString(),
      created_by: userId,
    })
    .returning();
  if (!row) throw new Error('Missing payer fixture');
  return row;
}

async function activeGrants(payerConnectionId: string) {
  return await db
    .select()
    .from(claude_billing_connection_grants)
    .where(
      and(
        eq(claude_billing_connection_grants.payer_connection_id, payerConnectionId),
        isNull(claude_billing_connection_grants.removed_at)
      )
    );
}

describe('Claude billing grants', () => {
  it('shares one payer across member and shared-services scopes', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude grants', user.id, 0);
    const payer = await connectedPayer(user.id);
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const member: ClaudeBillingOwner = {
      kind: 'member',
      kiloUserId: user.id,
      organizationId: organization.id,
    };
    const shared: ClaudeBillingOwner = {
      kind: 'shared_services',
      organizationId: organization.id,
    };

    await shareClaudeBillingConnection(personal, member, user.id);
    await shareClaudeBillingConnection(personal, shared, user.id);

    await expect(
      Promise.all([
        getGrantedClaudeBillingConnection(personal),
        getGrantedClaudeBillingConnection(member),
        getGrantedClaudeBillingConnection(shared),
      ])
    ).resolves.toEqual([
      expect.objectContaining({ id: payer.id }),
      expect.objectContaining({ id: payer.id }),
      expect.objectContaining({ id: payer.id }),
    ]);
    await expect(activeGrants(payer.id)).resolves.toHaveLength(3);

    await removeClaudeBillingGrant(member);
    await removeClaudeBillingGrant(shared);

    await expect(
      Promise.all([
        getGrantedClaudeBillingConnection(member),
        getGrantedClaudeBillingConnection(shared),
        getGrantedClaudeBillingConnection(personal),
      ])
    ).resolves.toEqual([null, null, expect.objectContaining({ id: payer.id })]);
  });

  it('shares an organization-first link back to personal and deletes only the personal Anthropic key', async () => {
    const user = await insertTestUser();
    const orgA = await createTestOrganization('Org First Alpha', user.id, 0);
    const orgB = await createTestOrganization('Org First Beta', user.id, 0);
    const [sharedFirstPayer] = await db
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
    if (!sharedFirstPayer) throw new Error('Missing shared-first payer fixture');
    await db.insert(byok_api_keys).values([
      {
        kilo_user_id: user.id,
        organization_id: null,
        provider_id: 'anthropic',
        created_by: user.id,
      },
      {
        kilo_user_id: null,
        organization_id: orgA.id,
        provider_id: 'anthropic',
        created_by: user.id,
      },
    ]);

    const sharedA: ClaudeBillingOwner = { kind: 'shared_services', organizationId: orgA.id };
    const memberA: ClaudeBillingOwner = {
      kind: 'member',
      kiloUserId: user.id,
      organizationId: orgA.id,
    };
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const memberB: ClaudeBillingOwner = {
      kind: 'member',
      kiloUserId: user.id,
      organizationId: orgB.id,
    };

    await shareClaudeBillingConnection(sharedA, personal, user.id);
    await shareClaudeBillingConnection(personal, memberA, user.id);
    await shareClaudeBillingConnection(memberA, memberB, user.id);

    await expect(
      Promise.all([
        getGrantedClaudeBillingConnection(sharedA),
        getGrantedClaudeBillingConnection(personal),
        getGrantedClaudeBillingConnection(memberA),
        getGrantedClaudeBillingConnection(memberB),
      ])
    ).resolves.toEqual([
      expect.objectContaining({ id: sharedFirstPayer.id }),
      expect.objectContaining({ id: sharedFirstPayer.id }),
      expect.objectContaining({ id: sharedFirstPayer.id }),
      expect.objectContaining({ id: sharedFirstPayer.id }),
    ]);

    const remainingKeys = await db
      .select()
      .from(byok_api_keys)
      .where(eq(byok_api_keys.created_by, user.id));
    expect(remainingKeys).toEqual([
      expect.objectContaining({ organization_id: orgA.id, kilo_user_id: null }),
    ]);
  });

  it('reassigns payer columns on initial-scope removal so the freed scope can link a second Claude account', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude multi account', user.id, 0);
    const firstPayer = await connectedPayer(user.id);
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const member: ClaudeBillingOwner = {
      kind: 'member',
      kiloUserId: user.id,
      organizationId: organization.id,
    };
    const shared: ClaudeBillingOwner = {
      kind: 'shared_services',
      organizationId: organization.id,
    };

    await shareClaudeBillingConnection(personal, member, user.id);
    await expect(removeClaudeBillingGrant(personal)).resolves.toBeNull();

    const secondProfile = await insertClaudeBillingProfile(
      personal,
      `uprof_second_${crypto.randomUUID()}`,
      user.id
    );
    await db
      .update(claude_billing_connections)
      .set({
        status: 'connected',
        connection_id: `ocon_${crypto.randomUUID()}`,
        connected_at: new Date().toISOString(),
      })
      .where(eq(claude_billing_connections.id, secondProfile.id));

    await expect(getGrantedClaudeBillingConnection(member)).resolves.toMatchObject({
      id: firstPayer.id,
      status: 'connected',
    });
    await expect(getGrantedClaudeBillingConnection(personal)).resolves.toMatchObject({
      id: secondProfile.id,
      status: 'connected',
    });

    const sharedChoices = await describeClaudeBillingSharing(user.id, shared, true, null);
    expect(sharedChoices.shareableLinks.map(link => link.payerId)).toEqual([
      firstPayer.id,
      secondProfile.id,
    ]);
    expect(sharedChoices.shareableLinks.map(link => link.label)).toEqual([
      'Claude multi account (member)',
      'Personal account',
    ]);
  });

  it('prevents another organization admin from sharing a shared-services payer they did not link', async () => {
    const alice = await insertTestUser();
    const bob = await insertTestUser();
    const organization = await createTestOrganization('Claude admin boundary', alice.id, 0);
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: bob.id,
      role: 'admin',
    });
    const [aliceSharedPayer] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: null,
        organization_id: organization.id,
        user_profile_id: `uprof_${crypto.randomUUID()}`,
        connection_id: `ocon_${crypto.randomUUID()}`,
        status: 'connected',
        connected_at: new Date().toISOString(),
        created_by: alice.id,
      })
      .returning();
    if (!aliceSharedPayer) throw new Error('Missing Alice shared payer');

    const shared: ClaudeBillingOwner = {
      kind: 'shared_services',
      organizationId: organization.id,
    };
    const bobPersonal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: bob.id };

    await expect(shareClaudeBillingConnection(shared, bobPersonal, bob.id)).rejects.toMatchObject({
      reason: 'source_forbidden',
    } satisfies Partial<ClaudeBillingShareError>);

    const bobSharing = await describeClaudeBillingSharing(bob.id, bobPersonal, true, null);
    expect(bobSharing.shareableLinks).toEqual([]);
  });

  it('refuses to replace a scope that uses another payer', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude occupied', user.id, 0);
    const personalPayer = await connectedPayer(user.id);
    const memberPayer = await connectedPayer(user.id, organization.id);
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const member: ClaudeBillingOwner = {
      kind: 'member',
      kiloUserId: user.id,
      organizationId: organization.id,
    };

    await expect(shareClaudeBillingConnection(personal, member, user.id)).rejects.toMatchObject({
      reason: 'target_connected',
    } satisfies Partial<ClaudeBillingShareError>);
    await expect(getGrantedClaudeBillingConnection(member)).resolves.toMatchObject({
      id: memberPayer.id,
    });
    await expect(getGrantedClaudeBillingConnection(personal)).resolves.toMatchObject({
      id: personalPayer.id,
    });
  });

  it('preserves a removed target profile row across grant removal and user erasure', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude preserved removed', user.id, 0);
    const [removedTarget] = await db
      .insert(claude_billing_connections)
      .values({
        kilo_user_id: null,
        organization_id: organization.id,
        user_profile_id: `uprof_old_${crypto.randomUUID()}`,
        status: 'removed',
        created_by: user.id,
      })
      .returning();
    if (!removedTarget) throw new Error('Missing removed target fixture');
    const payer = await connectedPayer(user.id);
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const shared: ClaudeBillingOwner = {
      kind: 'shared_services',
      organizationId: organization.id,
    };
    const member: ClaudeBillingOwner = {
      kind: 'member',
      kiloUserId: user.id,
      organizationId: organization.id,
    };

    await shareClaudeBillingConnection(personal, shared, user.id);
    await shareClaudeBillingConnection(personal, member, user.id);
    await removeClaudeBillingGrant(personal);
    await expect(getGrantedClaudeBillingConnection(member)).resolves.toMatchObject({
      id: payer.id,
      kilo_user_id: user.id,
      organization_id: organization.id,
    });

    await removeUserClaudeBillingGrants(user.id, db);
    await expect(getGrantedClaudeBillingConnection(shared)).resolves.toMatchObject({
      id: payer.id,
      kilo_user_id: null,
      organization_id: organization.id,
    });
    const retainedOldRows = await db
      .select()
      .from(claude_billing_connections)
      .where(eq(claude_billing_connections.id, removedTarget.id));
    expect(retainedOldRows).toHaveLength(1);
  });
});

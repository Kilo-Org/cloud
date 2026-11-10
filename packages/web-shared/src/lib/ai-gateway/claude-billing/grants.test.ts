import { describe, expect, it } from '@jest/globals';
import { and, eq, isNull } from 'drizzle-orm';
import { claude_billing_connection_grants, claude_billing_connections } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  type ClaudeBillingShareError,
  activateClaudeBillingGrant,
  getClaudeBillingConnectionIncludingRemoved,
  getGrantedClaudeBillingConnection,
  removeClaudeBillingGrant,
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

  it('reuses the payer after the initial scope stops using it', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude reconnect', user.id, 0);
    const payer = await connectedPayer(user.id);
    const personal: ClaudeBillingOwner = { kind: 'personal', kiloUserId: user.id };
    const member: ClaudeBillingOwner = {
      kind: 'member',
      kiloUserId: user.id,
      organizationId: organization.id,
    };

    await shareClaudeBillingConnection(personal, member, user.id);
    await removeClaudeBillingGrant(personal);

    await expect(getGrantedClaudeBillingConnection(personal)).resolves.toBeNull();
    await expect(getGrantedClaudeBillingConnection(member)).resolves.toMatchObject({
      id: payer.id,
    });
    await expect(getClaudeBillingConnectionIncludingRemoved(personal)).resolves.toMatchObject({
      id: payer.id,
      user_profile_id: payer.user_profile_id,
    });

    await activateClaudeBillingGrant(personal, payer.id, user.id);
    await expect(getGrantedClaudeBillingConnection(personal)).resolves.toMatchObject({
      id: payer.id,
    });
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

  it('promotes over a previously removed target row and preserves member identity', async () => {
    const user = await insertTestUser();
    const organization = await createTestOrganization('Claude promoted', user.id, 0);
    await db.insert(claude_billing_connections).values({
      kilo_user_id: null,
      organization_id: organization.id,
      user_profile_id: `uprof_old_${crypto.randomUUID()}`,
      status: 'removed',
      created_by: user.id,
    });
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

    await expect(getGrantedClaudeBillingConnection(shared)).resolves.toMatchObject({
      id: payer.id,
      kilo_user_id: null,
      organization_id: organization.id,
    });
    await expect(getGrantedClaudeBillingConnection(member)).resolves.toMatchObject({
      id: payer.id,
      kilo_user_id: user.id,
      organization_id: organization.id,
    });
  });
});

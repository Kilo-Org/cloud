jest.mock('@kilocode/web-shared/lib/auth/claude/feature-flag.server', () => ({
  isClaudePlatformOAuthEnabled: jest.fn(async () => true),
}));

import { beforeEach, describe, expect, it } from '@jest/globals';
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
});

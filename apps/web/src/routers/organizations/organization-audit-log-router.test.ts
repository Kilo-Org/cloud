import { afterEach, describe, expect, it } from '@jest/globals';
import { organization_audit_logs, organization_memberships } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

const STAFF_ACTOR = {
  actor_id: 'staff-actor',
  actor_email: 'engineer@kilocode.ai',
  actor_name: 'Staff Engineer',
};

const SECOND_DOMAIN_STAFF_ACTOR = {
  actor_id: 'second-domain-staff-actor',
  actor_email: 'engineer@anaconda.com',
  actor_name: 'Second Domain Engineer',
};

const CUSTOMER_ACTOR = {
  actor_id: 'customer-actor',
  actor_email: 'owner@example.test',
  actor_name: 'Customer Owner',
};

const MASKED_ACTOR = {
  actor_id: '00000000-0000-0000-0000-000000000000',
  actor_email: 'admin@kilocode.ai',
  actor_name: 'Kilo Admin',
};

async function seedOrganizationWithAuditEntries() {
  const founder = await insertTestUser();
  const organization = await createTestOrganization(
    `Audit visibility ${crypto.randomUUID()}`,
    founder.id,
    0
  );

  await db.insert(organization_audit_logs).values([
    {
      organization_id: organization.id,
      action: 'organization.settings.change',
      message: 'staff change',
      ...STAFF_ACTOR,
    },
    {
      organization_id: organization.id,
      action: 'organization.settings.change',
      message: 'second domain staff change',
      ...SECOND_DOMAIN_STAFF_ACTOR,
    },
    {
      organization_id: organization.id,
      action: 'organization.settings.change',
      message: 'customer change',
      ...CUSTOMER_ACTOR,
    },
  ]);

  return organization;
}

async function addBillingManager(organizationId: string, kiloUserId: string) {
  await db.insert(organization_memberships).values({
    organization_id: organizationId,
    kilo_user_id: kiloUserId,
    role: 'billing_manager',
  });
}

type ListedLog = {
  message: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
};

function actorsByMessage(logs: ListedLog[]) {
  return Object.fromEntries(
    logs.map(log => [
      log.message,
      { actor_id: log.actor_id, actor_email: log.actor_email, actor_name: log.actor_name },
    ])
  );
}

describe('organizations.auditLog.list actor details follow the account permission', () => {
  afterEach(cleanupDbForTest);

  it('shows generic actor fields to a billing member', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const billingMember = await insertTestUser({
      google_user_email: 'billing-manager@kilocode.ai',
    });
    await addBillingManager(organization.id, billingMember.id);

    const caller = await createCallerForUser(billingMember.id);
    const { logs } = await caller.organizations.auditLogs.list({
      organizationId: organization.id,
    });
    const actors = actorsByMessage(logs);

    expect(actors['staff change']).toEqual(MASKED_ACTOR);
    expect(actors['second domain staff change']).toEqual(MASKED_ACTOR);
    expect(actors['customer change']).toEqual(CUSTOMER_ACTOR);
  });

  it('shows stored actor fields to a platform admin', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const admin = await insertTestUser({
      google_user_email: 'administrator@example.test',
      is_admin: true,
    });
    await addBillingManager(organization.id, admin.id);

    const caller = await createCallerForUser(admin.id);
    const { logs } = await caller.organizations.auditLogs.list({
      organizationId: organization.id,
    });
    const actors = actorsByMessage(logs);

    expect(actors['staff change']).toEqual(STAFF_ACTOR);
    expect(actors['second domain staff change']).toEqual(SECOND_DOMAIN_STAFF_ACTOR);
    expect(actors['customer change']).toEqual(CUSTOMER_ACTOR);
  });

  it('requires an unblocked account for a blocked admin', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const blockedAdmin = await insertTestUser({
      google_user_email: 'blocked-administrator@example.test',
      is_admin: true,
      blocked_reason: 'blocked for test',
    });
    await addBillingManager(organization.id, blockedAdmin.id);

    const caller = await createCallerForUser(blockedAdmin.id);
    const { logs } = await caller.organizations.auditLogs.list({
      organizationId: organization.id,
    });
    const actors = actorsByMessage(logs);

    expect(actors['staff change']).toEqual(MASKED_ACTOR);
    expect(actors['customer change']).toEqual(CUSTOMER_ACTOR);
  });
});

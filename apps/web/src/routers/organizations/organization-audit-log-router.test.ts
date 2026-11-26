import { afterEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import {
  organization_audit_logs,
  organization_memberships,
  support_access_grants,
} from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  createBearerCallerForUser,
  createCallerForUser,
  createSessionCallerForUser,
} from '@/routers/test-utils';
import {
  ALLOWED_ADMIN_ADDRESS,
  OFF_NETWORK_ADDRESS,
  withAdminStepUpEnabled,
  withEnforcedAdminNetwork,
} from '@/tests/helpers/admin-network.helper';

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

describe('organizations.auditLog.list actor details', () => {
  afterEach(cleanupDbForTest);

  it('shows generic actor fields to a billing member', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const billingMember = await insertTestUser({
      google_user_email: 'billing-manager@kilocode.ai',
    });
    await addBillingManager(organization.id, billingMember.id);

    const caller = await createSessionCallerForUser(billingMember.id);
    const { logs } = await caller.organizations.auditLogs.list({
      organizationId: organization.id,
    });
    const actors = actorsByMessage(logs);

    expect(actors['staff change']).toEqual(MASKED_ACTOR);
    expect(actors['second domain staff change']).toEqual(MASKED_ACTOR);
    expect(actors['customer change']).toEqual(CUSTOMER_ACTOR);
  });

  it('shows generic actor fields to a staff bearer member without running the guard', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const admin = await insertTestUser({
      google_user_email: 'administrator-bearer@example.test',
      is_admin: true,
    });
    await addBillingManager(organization.id, admin.id);

    await withEnforcedAdminNetwork(async () => {
      const caller = await createCallerForUser(admin.id, { headers: OFF_NETWORK_ADDRESS });
      const { logs } = await caller.organizations.auditLogs.list({
        organizationId: organization.id,
      });
      expect(actorsByMessage(logs)['staff change']).toEqual(MASKED_ACTOR);
    });
  });

  it('shows generic actor fields to a staff browser member off-network and without a proof', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const admin = await insertTestUser({
      google_user_email: 'administrator-member@example.test',
      is_admin: true,
    });
    await addBillingManager(organization.id, admin.id);

    await withEnforcedAdminNetwork(() =>
      withAdminStepUpEnabled(async () => {
        const caller = await createSessionCallerForUser(admin.id, {
          headers: OFF_NETWORK_ADDRESS,
        });
        const { logs } = await caller.organizations.auditLogs.list({
          organizationId: organization.id,
        });
        const actors = actorsByMessage(logs);

        expect(actors['staff change']).toEqual(MASKED_ACTOR);
        expect(actors['customer change']).toEqual(CUSTOMER_ACTOR);
      })
    );
  });

  it('shows generic actor fields to a blocked admin member', async () => {
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
    expect(actorsByMessage(logs)['staff change']).toEqual(MASKED_ACTOR);
  });

  it('shows stored actor fields to a non-member staff browser session the guard admits', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const admin = await insertTestUser({
      google_user_email: 'administrator@example.test',
      is_admin: true,
    });

    await withEnforcedAdminNetwork(async () => {
      const caller = await createSessionCallerForUser(admin.id, {
        headers: ALLOWED_ADMIN_ADDRESS,
      });
      const { logs } = await caller.organizations.auditLogs.list({
        organizationId: organization.id,
      });
      const actors = actorsByMessage(logs);

      expect(actors['staff change']).toEqual(STAFF_ACTOR);
      expect(actors['second domain staff change']).toEqual(SECOND_DOMAIN_STAFF_ACTOR);
      expect(actors['customer change']).toEqual(CUSTOMER_ACTOR);
    });
  });

  it('refuses a non-member staff browser session off the admin network', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const admin = await insertTestUser({
      google_user_email: 'administrator-off-network@example.test',
      is_admin: true,
    });

    await withEnforcedAdminNetwork(async () => {
      const caller = await createSessionCallerForUser(admin.id, { headers: OFF_NETWORK_ADDRESS });
      await expect(
        caller.organizations.auditLogs.list({ organizationId: organization.id })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('Cloudflare WARP'),
      });
    });
  });

  it('refuses a non-member staff bearer caller', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const admin = await insertTestUser({
      google_user_email: 'administrator-non-member-bearer@example.test',
      is_admin: true,
    });

    const caller = await createBearerCallerForUser(admin.id);
    await expect(
      caller.organizations.auditLogs.list({ organizationId: organization.id })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ code: 'BEARER_NOT_ALLOWED' }),
    });
  });

  it('shows generic actor fields under a support grant', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const admin = await insertTestUser({
      google_user_email: 'administrator-support@example.test',
      is_admin: true,
    });
    const now = new Date();
    await db.insert(support_access_grants).values({
      actor_kilo_user_id: admin.id,
      organization_id: organization.id,
      action_class: 'support_read',
      status: 'active',
      reason: 'investigating a customer report',
      requested_duration_seconds: 1800,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    });

    process.env.SUPPORT_ACCESS_ENABLED = 'true';
    try {
      const caller = await createSessionCallerForUser(admin.id);
      const { logs } = await caller.organizations.auditLogs.list({
        organizationId: organization.id,
      });
      const actors = actorsByMessage(logs);

      expect(actors['staff change']).toEqual(MASKED_ACTOR);
      expect(actors['customer change']).toEqual(CUSTOMER_ACTOR);
    } finally {
      delete process.env.SUPPORT_ACCESS_ENABLED;
      await db
        .delete(support_access_grants)
        .where(eq(support_access_grants.actor_kilo_user_id, admin.id));
    }
  });
});

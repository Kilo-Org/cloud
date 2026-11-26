import { afterEach, describe, expect, it } from '@jest/globals';
import { security_audit_log } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser, createSessionCallerForUser } from '@/routers/test-utils';
import {
  OFF_NETWORK_ADDRESS,
  withAdminStepUpEnabled,
  withEnforcedAdminNetwork,
} from '@/tests/helpers/admin-network.helper';
import { SecurityAuditLogAction } from '@/lib/security-agent/core/enums';

const STAFF_ACTOR = {
  actor_id: 'staff-actor',
  actor_email: 'engineer@kilocode.ai',
  actor_name: 'Staff Engineer',
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

async function seedPersonalAuditEntries(kiloUserId: string) {
  await db.insert(security_audit_log).values([
    {
      owned_by_user_id: kiloUserId,
      action: SecurityAuditLogAction.ConfigUpdated,
      resource_type: 'security_config',
      resource_id: 'staff-resource',
      ...STAFF_ACTOR,
    },
    {
      owned_by_user_id: kiloUserId,
      action: SecurityAuditLogAction.ConfigUpdated,
      resource_type: 'security_config',
      resource_id: 'customer-resource',
      ...CUSTOMER_ACTOR,
    },
  ]);
}

type ListedLog = {
  resource_id: string;
  actor_id: string | null;
  actor_email: string | null;
  actor_name: string | null;
};

function actorsByResource(logs: ListedLog[]) {
  return Object.fromEntries(
    logs.map(log => [
      log.resource_id,
      { actor_id: log.actor_id, actor_email: log.actor_email, actor_name: log.actor_name },
    ])
  );
}

function exportedActorsByResource(data: string) {
  return actorsByResource(JSON.parse(data) as ListedLog[]);
}

async function insertUserWithEntries(overrides: Parameters<typeof insertTestUser>[0]) {
  const user = await insertTestUser(overrides);
  await seedPersonalAuditEntries(user.id);
  return user;
}

describe('securityAuditLog shows an account its own log with staff actors masked', () => {
  afterEach(cleanupDbForTest);

  it('masks staff actors for an account without the platform admin flag', async () => {
    const user = await insertUserWithEntries({ google_user_email: 'engineer-viewer@kilocode.ai' });
    const caller = await createSessionCallerForUser(user.id);

    const { logs } = await caller.securityAuditLog.list({});
    const actors = actorsByResource(logs);
    expect(actors['staff-resource']).toEqual(MASKED_ACTOR);
    expect(actors['customer-resource']).toEqual(CUSTOMER_ACTOR);

    const exported = await caller.securityAuditLog.export({ format: 'json' });
    expect(exportedActorsByResource(exported.data)['staff-resource']).toEqual(MASKED_ACTOR);

    const csv = await caller.securityAuditLog.export({ format: 'csv' });
    expect(csv.data).toContain('"admin@kilocode.ai"');
    expect(csv.data).not.toContain('"engineer@kilocode.ai"');
  });

  it('masks staff actors for a staff bearer caller without running the guard', async () => {
    const admin = await insertUserWithEntries({
      google_user_email: 'administrator-bearer@example.test',
      is_admin: true,
    });

    await withEnforcedAdminNetwork(async () => {
      // Off the admin network, so a guard run would refuse.
      const caller = await createCallerForUser(admin.id, { headers: OFF_NETWORK_ADDRESS });

      const { logs } = await caller.securityAuditLog.list({});
      expect(actorsByResource(logs)['staff-resource']).toEqual(MASKED_ACTOR);

      const exported = await caller.securityAuditLog.export({ format: 'json' });
      expect(exportedActorsByResource(exported.data)['staff-resource']).toEqual(MASKED_ACTOR);
    });
  });

  it('serves a staff browser session its masked log off-network and without a proof', async () => {
    const admin = await insertUserWithEntries({
      google_user_email: 'administrator@example.test',
      is_admin: true,
    });

    await withEnforcedAdminNetwork(() =>
      withAdminStepUpEnabled(async () => {
        const caller = await createSessionCallerForUser(admin.id, {
          headers: OFF_NETWORK_ADDRESS,
        });

        const { logs } = await caller.securityAuditLog.list({});
        const actors = actorsByResource(logs);
        expect(actors['staff-resource']).toEqual(MASKED_ACTOR);
        expect(actors['customer-resource']).toEqual(CUSTOMER_ACTOR);

        const exported = await caller.securityAuditLog.export({ format: 'json' });
        expect(exportedActorsByResource(exported.data)['staff-resource']).toEqual(MASKED_ACTOR);

        const csv = await caller.securityAuditLog.export({ format: 'csv' });
        expect(csv.data).toContain('"admin@kilocode.ai"');
        expect(csv.data).not.toContain('"engineer@kilocode.ai"');
      })
    );
  });

  it('masks staff actors for a blocked admin', async () => {
    const blockedAdmin = await insertUserWithEntries({
      google_user_email: 'blocked-administrator@example.test',
      is_admin: true,
      blocked_reason: 'blocked for test',
    });
    const caller = await createCallerForUser(blockedAdmin.id);

    const { logs } = await caller.securityAuditLog.list({});
    const actors = actorsByResource(logs);
    expect(actors['staff-resource']).toEqual(MASKED_ACTOR);
    expect(actors['customer-resource']).toEqual(CUSTOMER_ACTOR);

    const exported = await caller.securityAuditLog.export({ format: 'json' });
    expect(exportedActorsByResource(exported.data)['staff-resource']).toEqual(MASKED_ACTOR);
  });
});

import { afterEach, describe, expect, it } from '@jest/globals';
import { security_audit_log } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
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

async function createCallerWithEntries(overrides: Parameters<typeof insertTestUser>[0]) {
  const user = await insertTestUser(overrides);
  await seedPersonalAuditEntries(user.id);
  return createCallerForUser(user.id);
}

describe('securityAuditLog actor details follow the account permission', () => {
  afterEach(cleanupDbForTest);

  it('requires the platform admin permission for a non-admin account', async () => {
    const caller = await createCallerWithEntries({
      google_user_email: 'engineer-viewer@kilocode.ai',
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
  });

  it('reads actor details when the account has the platform admin permission', async () => {
    const caller = await createCallerWithEntries({
      google_user_email: 'administrator@example.test',
      is_admin: true,
    });

    const { logs } = await caller.securityAuditLog.list({});
    const actors = actorsByResource(logs);
    expect(actors['staff-resource']).toEqual(STAFF_ACTOR);
    expect(actors['customer-resource']).toEqual(CUSTOMER_ACTOR);

    const exported = await caller.securityAuditLog.export({ format: 'json' });
    expect(exportedActorsByResource(exported.data)['staff-resource']).toEqual(STAFF_ACTOR);

    const csv = await caller.securityAuditLog.export({ format: 'csv' });
    expect(csv.data).toContain('"engineer@kilocode.ai"');
    expect(csv.data).not.toContain('"admin@kilocode.ai"');
  });

  it('requires an unblocked account for a blocked admin', async () => {
    const caller = await createCallerWithEntries({
      google_user_email: 'blocked-administrator@example.test',
      is_admin: true,
      blocked_reason: 'blocked for test',
    });

    const { logs } = await caller.securityAuditLog.list({});
    const actors = actorsByResource(logs);
    expect(actors['staff-resource']).toEqual(MASKED_ACTOR);
    expect(actors['customer-resource']).toEqual(CUSTOMER_ACTOR);

    const exported = await caller.securityAuditLog.export({ format: 'json' });
    expect(exportedActorsByResource(exported.data)['staff-resource']).toEqual(MASKED_ACTOR);
  });
});

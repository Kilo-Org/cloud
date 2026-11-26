import { afterEach, describe, expect, it } from '@jest/globals';
import { and, eq } from 'drizzle-orm';
import { organization_memberships, security_audit_log } from '@kilocode/db/schema';
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
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';
import { TRPCError } from '@trpc/server';
import { SecurityAuditLogAction } from '@/lib/security-agent/core/enums';

const COLUMNS = [
  'id',
  'timestamp',
  'action',
  'actor_id',
  'actor_email',
  'actor_name',
  'resource_type',
  'resource_id',
  'before_state',
  'after_state',
  'metadata',
] as const;

const cell = (row: string[], column: (typeof COLUMNS)[number]): string => {
  const index = COLUMNS.indexOf(column);
  if (index === -1) throw new Error(`Unknown column ${column}`);
  return row[index];
};

/** Parse one exported CSV line, honouring doubled quotes inside quoted cells. */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quoted) {
      if (character === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index++;
        } else {
          quoted = false;
        }
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      cells.push(current);
      current = '';
    } else {
      current += character;
    }
  }

  cells.push(current);
  return cells;
}

async function seedOrganizationAuditRow(
  values: Partial<typeof security_audit_log.$inferInsert> = {}
) {
  const owner = await insertTestUser();
  const organization = await createTestOrganization(
    `Audit export ${crypto.randomUUID()}`,
    owner.id,
    0
  );

  await db.insert(security_audit_log).values({
    owned_by_organization_id: organization.id,
    actor_id: 'actor-1',
    actor_email: 'analyst@example.test',
    actor_name: 'Analyst',
    action: SecurityAuditLogAction.ConfigUpdated,
    resource_type: 'security_config',
    resource_id: 'config-1',
    metadata: { source: 'test' },
    ...values,
  });

  return { owner, organization };
}

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

async function seedOrganizationWithAuditEntries() {
  const founder = await insertTestUser();
  const organization = await createTestOrganization(
    `Audit visibility ${crypto.randomUUID()}`,
    founder.id,
    0
  );

  await db.insert(security_audit_log).values([
    {
      owned_by_organization_id: organization.id,
      action: SecurityAuditLogAction.ConfigUpdated,
      resource_type: 'security_config',
      resource_id: 'staff-resource',
      ...STAFF_ACTOR,
    },
    {
      owned_by_organization_id: organization.id,
      action: SecurityAuditLogAction.ConfigUpdated,
      resource_type: 'security_config',
      resource_id: 'customer-resource',
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

describe('organizations.securityAuditLog.export', () => {
  afterEach(cleanupDbForTest);

  it('writes each exported cell as literal text', async () => {
    const actorName = '=SUM(A1)';
    const { owner, organization } = await seedOrganizationAuditRow({
      actor_email: '+analyst@example.test',
      actor_name: actorName,
      resource_id: '=2+2',
      metadata: { value: '=2+2' },
    });

    const caller = await createCallerForUser(owner.id);
    const result = await caller.organizations.securityAuditLog.export({
      organizationId: organization.id,
      format: 'csv',
    });

    const [header, ...rows] = result.data.split('\n');
    expect(parseCsvLine(header)).toEqual([...COLUMNS]);
    expect(rows).toHaveLength(1);

    const row = parseCsvLine(rows[0]);
    expect(cell(row, 'actor_email')).toBe("'+analyst@example.test");
    expect(cell(row, 'actor_name')).toBe(`'${actorName}`);
    expect(cell(row, 'resource_id')).toBe("'=2+2");
    expect(cell(row, 'action')).toBe(SecurityAuditLogAction.ConfigUpdated);
    expect(cell(row, 'actor_id')).toBe('actor-1');
    expect(cell(row, 'metadata')).toBe('{"value":"=2+2"}');

    expect(rows[0]).toContain(`"'=SUM(A1)"`);
    expect(rows[0]).toContain(`"'+analyst@example.test"`);
    expect(rows[0]).toContain('"{""value"":""=2+2""}"');
  });

  it('exports ordinary values unchanged and leaves the JSON export untouched', async () => {
    const { owner, organization } = await seedOrganizationAuditRow();
    const caller = await createCallerForUser(owner.id);

    const csv = await caller.organizations.securityAuditLog.export({
      organizationId: organization.id,
      format: 'csv',
    });
    const row = parseCsvLine(csv.data.split('\n')[1]);
    expect(cell(row, 'actor_email')).toBe('analyst@example.test');
    expect(cell(row, 'actor_name')).toBe('Analyst');
    expect(cell(row, 'metadata')).toBe('{"source":"test"}');
    expect(cell(row, 'timestamp')).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);

    const json = await caller.organizations.securityAuditLog.export({
      organizationId: organization.id,
      format: 'json',
    });
    const entries = JSON.parse(json.data) as {
      action: string;
      actor_email: string;
      actor_name: string;
    }[];
    const entry = entries.find(row => row.action === SecurityAuditLogAction.ConfigUpdated);
    expect(entry?.actor_email).toBe('analyst@example.test');
    expect(entry?.actor_name).toBe('Analyst');
  });
});

/** Export audit rows recorded for the organization's audit log. */
async function exportRows(organizationId: string) {
  return db
    .select({ id: security_audit_log.id })
    .from(security_audit_log)
    .where(
      and(
        eq(security_audit_log.owned_by_organization_id, organizationId),
        eq(security_audit_log.action, SecurityAuditLogAction.AuditLogExported)
      )
    );
}

describe('organizations.securityAuditLog actor details', () => {
  afterEach(cleanupDbForTest);

  it('masks staff actors for an organization billing member', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const billingMember = await insertTestUser({
      google_user_email: 'billing-manager@kilocode.ai',
    });
    await addBillingManager(organization.id, billingMember.id);

    const caller = await createSessionCallerForUser(billingMember.id);
    const { logs } = await caller.organizations.securityAuditLog.list({
      organizationId: organization.id,
    });
    const actors = actorsByResource(logs);
    expect(actors['staff-resource']).toEqual(MASKED_ACTOR);
    expect(actors['customer-resource']).toEqual(CUSTOMER_ACTOR);

    const exported = await caller.organizations.securityAuditLog.export({
      organizationId: organization.id,
      format: 'json',
    });
    expect(exportedActorsByResource(exported.data)['staff-resource']).toEqual(MASKED_ACTOR);

    const csv = await caller.organizations.securityAuditLog.export({
      organizationId: organization.id,
      format: 'csv',
    });
    expect(csv.data).toContain('"admin@kilocode.ai"');
    expect(csv.data).not.toContain('"engineer@kilocode.ai"');
  });

  it('masks staff actors for a staff bearer member without running the guard', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const admin = await insertTestUser({
      google_user_email: 'administrator-bearer@example.test',
      is_admin: true,
    });
    await addBillingManager(organization.id, admin.id);

    await withEnforcedAdminNetwork(async () => {
      const caller = await createCallerForUser(admin.id, { headers: OFF_NETWORK_ADDRESS });
      const { logs } = await caller.organizations.securityAuditLog.list({
        organizationId: organization.id,
      });
      expect(actorsByResource(logs)['staff-resource']).toEqual(MASKED_ACTOR);

      const exported = await caller.organizations.securityAuditLog.export({
        organizationId: organization.id,
        format: 'json',
      });
      expect(exportedActorsByResource(exported.data)['staff-resource']).toEqual(MASKED_ACTOR);
    });
  });

  it('masks staff actors for a staff browser member off-network and without a proof', async () => {
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
        const { logs } = await caller.organizations.securityAuditLog.list({
          organizationId: organization.id,
        });
        const actors = actorsByResource(logs);
        expect(actors['staff-resource']).toEqual(MASKED_ACTOR);
        expect(actors['customer-resource']).toEqual(CUSTOMER_ACTOR);

        const exported = await caller.organizations.securityAuditLog.export({
          organizationId: organization.id,
          format: 'json',
        });
        expect(exportedActorsByResource(exported.data)['staff-resource']).toEqual(MASKED_ACTOR);

        const csv = await caller.organizations.securityAuditLog.export({
          organizationId: organization.id,
          format: 'csv',
        });
        expect(csv.data).toContain('"admin@kilocode.ai"');
        expect(csv.data).not.toContain('"engineer@kilocode.ai"');
      })
    );
  });

  it('masks staff actors for a blocked admin member', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const blockedAdmin = await insertTestUser({
      google_user_email: 'blocked-administrator@example.test',
      is_admin: true,
      blocked_reason: 'blocked for test',
    });
    await addBillingManager(organization.id, blockedAdmin.id);

    const caller = await createCallerForUser(blockedAdmin.id);
    const { logs } = await caller.organizations.securityAuditLog.list({
      organizationId: organization.id,
    });
    expect(actorsByResource(logs)['staff-resource']).toEqual(MASKED_ACTOR);

    const exported = await caller.organizations.securityAuditLog.export({
      organizationId: organization.id,
      format: 'json',
    });
    expect(exportedActorsByResource(exported.data)['staff-resource']).toEqual(MASKED_ACTOR);
  });

  it('reads actor details for a non-member staff browser session the guard admits', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const admin = await insertTestUser({
      google_user_email: 'administrator@example.test',
      is_admin: true,
    });

    await withEnforcedAdminNetwork(async () => {
      const caller = await createSessionCallerForUser(admin.id, {
        headers: ALLOWED_ADMIN_ADDRESS,
      });
      const { logs } = await caller.organizations.securityAuditLog.list({
        organizationId: organization.id,
      });
      const actors = actorsByResource(logs);
      expect(actors['staff-resource']).toEqual(STAFF_ACTOR);
      expect(actors['customer-resource']).toEqual(CUSTOMER_ACTOR);

      const exported = await caller.organizations.securityAuditLog.export({
        organizationId: organization.id,
        format: 'json',
      });
      expect(exportedActorsByResource(exported.data)['staff-resource']).toEqual(STAFF_ACTOR);

      const csv = await caller.organizations.securityAuditLog.export({
        organizationId: organization.id,
        format: 'csv',
      });
      expect(csv.data).toContain('"engineer@kilocode.ai"');
      expect(csv.data).not.toContain('"admin@kilocode.ai"');
    });
  });

  it('asks a non-member staff export for its own write proof only, before recording it', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const admin = await insertTestUser({
      google_user_email: 'administrator-no-proof@example.test',
      is_admin: true,
    });

    await withAdminStepUpEnabled(async () => {
      const caller = await createSessionCallerForUser(admin.id);
      const error: unknown = await caller.organizations.securityAuditLog
        .export({ organizationId: organization.id, format: 'json' })
        .catch(caught => caught);

      if (!(error instanceof TRPCError)) throw error;
      expect(error.code).toBe('FORBIDDEN');
      expect(error.cause).toBeInstanceOf(StepUpRequiredError);
      expect(error.cause).toMatchObject({ actionClass: 'support_write' });
    });

    expect(await exportRows(organization.id)).toEqual([]);
  });

  it('refuses a non-member staff browser session off the admin network before recording an export', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const admin = await insertTestUser({
      google_user_email: 'administrator-off-network@example.test',
      is_admin: true,
    });

    await withEnforcedAdminNetwork(async () => {
      const caller = await createSessionCallerForUser(admin.id, { headers: OFF_NETWORK_ADDRESS });
      const refusal = { code: 'FORBIDDEN', message: expect.stringContaining('Cloudflare WARP') };

      await expect(
        caller.organizations.securityAuditLog.list({ organizationId: organization.id })
      ).rejects.toMatchObject(refusal);
      await expect(
        caller.organizations.securityAuditLog.export({
          organizationId: organization.id,
          format: 'csv',
        })
      ).rejects.toMatchObject(refusal);
    });

    expect(await exportRows(organization.id)).toEqual([]);
  });

  it('refuses a non-member staff bearer caller before recording an export', async () => {
    const organization = await seedOrganizationWithAuditEntries();
    const admin = await insertTestUser({
      google_user_email: 'administrator-non-member-bearer@example.test',
      is_admin: true,
    });
    const caller = await createBearerCallerForUser(admin.id);
    const refusal = {
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ code: 'BEARER_NOT_ALLOWED' }),
    };

    await expect(
      caller.organizations.securityAuditLog.list({ organizationId: organization.id })
    ).rejects.toMatchObject(refusal);
    await expect(
      caller.organizations.securityAuditLog.export({
        organizationId: organization.id,
        format: 'json',
      })
    ).rejects.toMatchObject(refusal);
    expect(await exportRows(organization.id)).toEqual([]);
  });
});

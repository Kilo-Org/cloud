import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { and, eq } from 'drizzle-orm';
import { security_audit_log, support_access_grants } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  setAdminAccessSinkForTest,
  type AdminAccessEvent,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';
import { TRPCError } from '@trpc/server';
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
import { SecurityAuditLogAction } from '@/lib/security-agent/core/enums';

process.env.SECURITY_AGENT_AUDIT_RELIABLE_COVERAGE_START = '2026-06-17T12:00:00.000Z';

const REPORT_RANGE = { startDate: '2026-07-01', endDate: '2026-07-31' };

let events: AdminAccessEvent[] = [];

function auditReportElevations() {
  return events.filter(
    event => event.kind === 'kilo_admin_elevation' && event.reason === 'security_agent_audit_report'
  );
}

async function personalReportAccessRows(kiloUserId: string) {
  return db
    .select({ id: security_audit_log.id })
    .from(security_audit_log)
    .where(
      and(
        eq(security_audit_log.owned_by_user_id, kiloUserId),
        eq(security_audit_log.action, SecurityAuditLogAction.AuditReportGenerated)
      )
    );
}

async function organizationReportAccessRows(organizationId: string) {
  return db
    .select({ id: security_audit_log.id })
    .from(security_audit_log)
    .where(
      and(
        eq(security_audit_log.owned_by_organization_id, organizationId),
        eq(security_audit_log.action, SecurityAuditLogAction.AuditReportGenerated)
      )
    );
}

async function insertOrganization(ownerId: string) {
  return createTestOrganization(`Audit report ${crypto.randomUUID()}`, ownerId, 0);
}

async function insertAdmin(email: string) {
  return insertTestUser({ google_user_email: email, is_admin: true });
}

beforeEach(() => {
  events = [];
  setAdminAccessSinkForTest(event => events.push(event));
});

afterEach(async () => {
  setAdminAccessSinkForTest(null);
  delete process.env.SUPPORT_ACCESS_ENABLED;
  await cleanupDbForTest();
});

describe('securityAgent.getAuditReport keeps an account report masked', () => {
  it('gives an ordinary browser session the masked report without a staff record', async () => {
    const user = await insertTestUser({ google_user_email: 'report-viewer@example.test' });
    const caller = await createSessionCallerForUser(user.id);

    await expect(caller.securityAgent.getAuditReport(REPORT_RANGE)).resolves.toMatchObject({
      status: 'ok',
    });
    expect(auditReportElevations()).toEqual([]);
    expect(await personalReportAccessRows(user.id)).toEqual([]);
  });

  it('gives a staff bearer caller the masked report without running the guard', async () => {
    const admin = await insertAdmin('report-admin-bearer@example.test');

    await withEnforcedAdminNetwork(async () => {
      const caller = await createCallerForUser(admin.id, { headers: OFF_NETWORK_ADDRESS });
      await expect(caller.securityAgent.getAuditReport(REPORT_RANGE)).resolves.toMatchObject({
        status: 'ok',
      });
    });
    expect(auditReportElevations()).toEqual([]);
    expect(await personalReportAccessRows(admin.id)).toEqual([]);
  });

  it('gives a staff browser session its masked report off-network and without a proof', async () => {
    const admin = await insertAdmin('report-admin@example.test');

    await withEnforcedAdminNetwork(() =>
      withAdminStepUpEnabled(async () => {
        const caller = await createSessionCallerForUser(admin.id, {
          headers: OFF_NETWORK_ADDRESS,
        });
        await expect(caller.securityAgent.getAuditReport(REPORT_RANGE)).resolves.toMatchObject({
          status: 'ok',
        });
      })
    );
    expect(auditReportElevations()).toEqual([]);
    expect(await personalReportAccessRows(admin.id)).toEqual([]);
  });
});

describe('organizations.securityAgent.getAuditReport staff actor unmask', () => {
  it('gives a staff member the masked report off-network and without a proof', async () => {
    const admin = await insertAdmin('report-admin-member@example.test');
    const organization = await insertOrganization(admin.id);

    await withEnforcedAdminNetwork(() =>
      withAdminStepUpEnabled(async () => {
        const caller = await createSessionCallerForUser(admin.id, {
          headers: OFF_NETWORK_ADDRESS,
        });
        await expect(
          caller.organizations.securityAgent.getAuditReport({
            organizationId: organization.id,
            ...REPORT_RANGE,
          })
        ).resolves.toMatchObject({ status: 'ok' });
      })
    );
    expect(auditReportElevations()).toEqual([]);
    expect(await organizationReportAccessRows(organization.id)).toEqual([]);
  });

  it('records the unmask for a non-member staff browser session the guard admits', async () => {
    const owner = await insertTestUser();
    const organization = await insertOrganization(owner.id);
    const admin = await insertAdmin('report-admin-staff@example.test');

    await withEnforcedAdminNetwork(async () => {
      const caller = await createSessionCallerForUser(admin.id, { headers: ALLOWED_ADMIN_ADDRESS });
      await expect(
        caller.organizations.securityAgent.getAuditReport({
          organizationId: organization.id,
          ...REPORT_RANGE,
        })
      ).resolves.toMatchObject({ status: 'ok' });
    });
    expect(auditReportElevations()).toEqual([
      expect.objectContaining({ target: `organization:${organization.id}` }),
    ]);
    expect(await organizationReportAccessRows(organization.id)).toHaveLength(1);
  });

  it('refuses a non-member staff browser session off the admin network before any record', async () => {
    const owner = await insertTestUser();
    const organization = await insertOrganization(owner.id);
    const admin = await insertAdmin('report-admin-off-network@example.test');

    await withEnforcedAdminNetwork(async () => {
      const caller = await createSessionCallerForUser(admin.id, { headers: OFF_NETWORK_ADDRESS });
      await expect(
        caller.organizations.securityAgent.getAuditReport({
          organizationId: organization.id,
          ...REPORT_RANGE,
        })
      ).rejects.toMatchObject({
        code: 'FORBIDDEN',
        message: expect.stringContaining('Cloudflare WARP'),
      });
    });
    expect(auditReportElevations()).toEqual([]);
    expect(await organizationReportAccessRows(organization.id)).toEqual([]);
  });

  it('refuses a non-member staff browser session without a step-up proof with the typed detail', async () => {
    const owner = await insertTestUser();
    const organization = await insertOrganization(owner.id);
    const admin = await insertAdmin('report-admin-step-up@example.test');

    await withAdminStepUpEnabled(async () => {
      const caller = await createSessionCallerForUser(admin.id);
      const error: unknown = await caller.organizations.securityAgent
        .getAuditReport({ organizationId: organization.id, ...REPORT_RANGE })
        .catch(caught => caught);

      if (!(error instanceof TRPCError)) throw error;
      expect(error.cause).toBeInstanceOf(StepUpRequiredError);
      expect(error.cause).toMatchObject({ actionClass: 'support_read' });
    });
    expect(auditReportElevations()).toEqual([]);
  });

  it('refuses a non-member staff bearer caller before any record', async () => {
    const owner = await insertTestUser();
    const organization = await insertOrganization(owner.id);
    const admin = await insertAdmin('report-admin-non-member-bearer@example.test');
    const caller = await createBearerCallerForUser(admin.id);

    await expect(
      caller.organizations.securityAgent.getAuditReport({
        organizationId: organization.id,
        ...REPORT_RANGE,
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ code: 'BEARER_NOT_ALLOWED' }),
    });
    expect(auditReportElevations()).toEqual([]);
    expect(await organizationReportAccessRows(organization.id)).toEqual([]);
  });

  it('keeps the report masked under a support grant', async () => {
    process.env.SUPPORT_ACCESS_ENABLED = 'true';
    const owner = await insertTestUser();
    const organization = await insertOrganization(owner.id);
    const admin = await insertAdmin('report-admin-support@example.test');
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

    try {
      const caller = await createSessionCallerForUser(admin.id);
      await expect(
        caller.organizations.securityAgent.getAuditReport({
          organizationId: organization.id,
          ...REPORT_RANGE,
        })
      ).resolves.toMatchObject({ status: 'ok' });
      expect(auditReportElevations()).toEqual([]);
      expect(await organizationReportAccessRows(organization.id)).toEqual([]);
    } finally {
      await db
        .delete(support_access_grants)
        .where(eq(support_access_grants.actor_kilo_user_id, admin.id));
    }
  });
});

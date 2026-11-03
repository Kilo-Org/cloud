import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { admin_action_audit_logs, organizations } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { defineTestUser, insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  addUserToOrganization,
  createOrganization,
} from '@kilocode/web-shared/lib/organizations/organizations';
import {
  organizationActionTarget,
  recordAdminAction,
  recordElevatedOrganizationAdminAction,
  recordAdminActions,
  setAdminActionSinkForTest,
  userActionTarget,
  type AdminActionContext,
  type AdminActionEvent,
} from '@/lib/admin/admin-action-audit';

function ctxFor(overrides: Partial<AdminActionContext> = {}): AdminActionContext {
  return {
    user: defineTestUser({ is_admin: true, is_super_admin: false }),
    authViaToken: false,
    tokenSource: null,
    ip: '203.0.113.7',
    trpcPath: 'admin.users.resetAPIKey',
    trpcType: 'mutation',
    ...overrides,
  };
}

describe('recordAdminAction', () => {
  let events: AdminActionEvent[];

  beforeEach(() => {
    events = [];
    setAdminActionSinkForTest(event => events.push(event));
  });

  afterEach(async () => {
    setAdminActionSinkForTest(null);
    await cleanupDbForTest();
  });

  test('inserts a row and emits a matching log event', async () => {
    const ctx = ctxFor();

    await recordAdminAction(ctx, {
      action: 'user.api_key.reset',
      target: userActionTarget('target-user'),
      message: 'Reset API key',
      metadata: { reason: 'support ticket' },
    });

    const rows = await db
      .select()
      .from(admin_action_audit_logs)
      .where(eq(admin_action_audit_logs.actor_id, ctx.user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'user.api_key.reset',
      actor_email: ctx.user.google_user_email,
      actor_name: ctx.user.google_user_name,
      target_type: 'user',
      target_id: 'target-user',
      message: 'Reset API key',
      metadata: { reason: 'support ticket' },
    });

    expect(events).toEqual([
      {
        event: 'admin_action',
        action: 'user.api_key.reset',
        auditLogId: rows[0]?.id,
        persisted: true,
        kiloUserId: ctx.user.id,
        email: ctx.user.google_user_email,
        adminTier: 'platform_admin',
        authVia: 'session',
        tokenSource: null,
        route: 'admin.users.resetAPIKey',
        ip: '203.0.113.7',
        targetType: 'user',
        targetId: 'target-user',
        message: 'Reset API key',
        metadata: { reason: 'support ticket' },
      },
    ]);
  });

  test('records actions without a target', async () => {
    await recordAdminAction(ctxFor(), {
      action: 'email_test.send',
      target: null,
      message: 'Sent test email',
    });

    const [row] = await db.select().from(admin_action_audit_logs);
    expect(row?.target_type).toBeNull();
    expect(row?.target_id).toBeNull();
    expect(events[0]).toMatchObject({ targetType: null, targetId: null, persisted: true });
  });

  test('still emits the log event, flagged unpersisted, when the insert fails', async () => {
    const insert = jest.spyOn(db, 'insert').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });

    try {
      await expect(
        recordAdminAction(ctxFor({ authViaToken: true, tokenSource: 'cloud-agent' }), {
          action: 'organization.delete',
          target: organizationActionTarget('org-1'),
          message: 'Deleted organization',
        })
      ).resolves.toBeUndefined();
    } finally {
      insert.mockRestore();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'organization.delete',
      persisted: false,
      auditLogId: null,
      authVia: 'token',
      tokenSource: 'cloud-agent',
    });
  });

  test('records one row and one event per entry across insert chunks', async () => {
    const userIds = Array.from({ length: 1_001 }, (_, index) => `bulk-user-${index}`);

    await recordAdminActions(
      ctxFor(),
      userIds.map(userId => ({
        action: 'user.unblock' as const,
        target: userActionTarget(userId),
        message: 'Unblocked user via bulk unblock',
      }))
    );

    const rows = await db
      .select({ target_id: admin_action_audit_logs.target_id })
      .from(admin_action_audit_logs);
    expect(rows.map(row => row.target_id).sort()).toEqual([...userIds].sort());
    expect(events).toHaveLength(userIds.length);
    expect(events.every(event => event.persisted && event.auditLogId !== null)).toBe(true);
  });

  test('does nothing for an empty batch', async () => {
    await recordAdminActions(ctxFor(), []);

    expect(await db.select().from(admin_action_audit_logs)).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe('recordElevatedOrganizationAdminAction', () => {
  beforeEach(() => setAdminActionSinkForTest(() => {}));
  afterEach(async () => {
    setAdminActionSinkForTest(null);
    await cleanupDbForTest();
  });

  async function adminWithInheritedOwnerRole() {
    const admin = await insertTestUser({ is_admin: true });
    const parent = await createOrganization('Parent Org', admin.id);
    const child = await createOrganization('Child Org', null);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    return { admin, childId: child.id };
  }

  function record(
    admin: Awaited<ReturnType<typeof insertTestUser>>,
    organizationId: string,
    scope?: 'direct'
  ) {
    return recordElevatedOrganizationAdminAction(
      { ...ctxFor(), user: admin },
      {
        organizationId,
        requiredRoles: ['owner'],
        membershipScope: scope,
        action: 'organization.gitlab_webhook_secret.rotate',
        message: 'GitLab webhook secret: rotate',
      }
    );
  }

  test('an inherited owner role satisfies inherited-scope guards but not direct-only guards', async () => {
    const { admin, childId } = await adminWithInheritedOwnerRole();

    await record(admin, childId);
    expect(await db.select().from(admin_action_audit_logs)).toHaveLength(0);

    await record(admin, childId, 'direct');
    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ heldRoles: [] });
  });

  test('does not record non-admins or admins holding a sufficient direct role', async () => {
    const owner = await insertTestUser({ is_admin: false });
    const organization = await createOrganization('Owned Org', owner.id);
    const adminOwner = await insertTestUser({ is_admin: true });
    await addUserToOrganization(organization.id, adminOwner.id, 'owner');

    await record(owner, organization.id);
    await record(adminOwner, organization.id, 'direct');

    expect(await db.select().from(admin_action_audit_logs)).toHaveLength(0);
  });

  test('records with unknown held roles instead of throwing when the membership lookup fails', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const select = jest.spyOn(db, 'select').mockImplementationOnce(() => {
      throw new Error('database unavailable');
    });
    try {
      await expect(record(admin, crypto.randomUUID())).resolves.toBeUndefined();
    } finally {
      select.mockRestore();
    }

    const rows = await db.select().from(admin_action_audit_logs);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toEqual({ heldRoles: null });
  });
});

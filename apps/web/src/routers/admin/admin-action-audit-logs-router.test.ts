import { afterEach, describe, expect, test } from '@jest/globals';
import { admin_action_audit_logs } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe('admin.actionAuditLogs.list', () => {
  afterEach(cleanupDbForTest);

  async function seed() {
    const admin = await insertTestUser({
      is_admin: true,
      google_user_email: `Auditor-${crypto.randomUUID()}@kilocode.ai`,
    });
    await db.insert(admin_action_audit_logs).values([
      {
        action: 'user.api_key.reset',
        actor_id: admin.id,
        actor_email: admin.google_user_email,
        target_type: 'user',
        target_id: 'user-a',
        message: 'Reset API key',
        created_at: minutesAgo(3),
      },
      {
        action: 'user.unblock',
        actor_id: admin.id,
        actor_email: admin.google_user_email,
        target_type: 'user',
        target_id: 'user-b',
        message: 'Unblocked user via bulk unblock',
        created_at: minutesAgo(2),
      },
      {
        action: 'organization.delete',
        actor_id: 'other-admin',
        actor_email: 'other-admin@kilocode.ai',
        target_type: 'organization',
        target_id: 'org-a',
        message: 'Deleted organization',
        created_at: minutesAgo(1),
      },
    ]);
    return admin;
  }

  test('lists newest first and pages with a cursor', async () => {
    const admin = await seed();
    const caller = await createCallerForUser(admin.id);

    const first = await caller.admin.actionAuditLogs.list({ limit: 2 });
    expect(first.rows.map(row => row.action)).toEqual(['organization.delete', 'user.unblock']);
    expect(first.nextCursor).not.toBeNull();

    const second = await caller.admin.actionAuditLogs.list({
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.rows.map(row => row.action)).toEqual(['user.api_key.reset']);
    expect(second.nextCursor).toBeNull();
  });

  test('filters by action, actor email (case-insensitive), target, and message', async () => {
    const admin = await seed();
    const caller = await createCallerForUser(admin.id);

    const byAction = await caller.admin.actionAuditLogs.list({ action: 'user.unblock' });
    expect(byAction.rows.map(row => row.targetId)).toEqual(['user-b']);

    const byActor = await caller.admin.actionAuditLogs.list({
      actorEmail: admin.google_user_email.toUpperCase(),
    });
    expect(byActor.rows).toHaveLength(2);

    const byTarget = await caller.admin.actionAuditLogs.list({
      targetType: 'organization',
      targetId: 'org-a',
    });
    expect(byTarget.rows.map(row => row.action)).toEqual(['organization.delete']);

    const bySearch = await caller.admin.actionAuditLogs.list({ search: 'bulk' });
    expect(bySearch.rows.map(row => row.action)).toEqual(['user.unblock']);
  });

  test('treats LIKE wildcards in search terms literally', async () => {
    const admin = await seed();
    const caller = await createCallerForUser(admin.id);

    const result = await caller.admin.actionAuditLogs.list({ search: '%' });
    expect(result.rows).toHaveLength(0);
  });

  test('rejects non-admin callers', async () => {
    const user = await insertTestUser({ is_admin: false });
    const caller = await createCallerForUser(user.id);

    await expect(caller.admin.actionAuditLogs.list({})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

import { beforeEach, describe, expect, it } from '@jest/globals';
import {
  admin_action_audit_logs,
  ai_gateway_request_logging_opt_ins,
  type User,
} from '@kilocode/db/schema';
import {
  getRequestLoggingOptIns,
  type RequestLoggingOptIn,
} from '@kilocode/web-shared/lib/ai-gateway/request-logging-opt-ins';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';
import { createCallerForUser } from '@/routers/test-utils';

let admin: User;
let nonAdmin: User;

function makeOptIn(): RequestLoggingOptIn {
  return {
    id: crypto.randomUUID(),
    target_type: 'account',
    target_id: `oauth/request-logging/${crypto.randomUUID()}`,
    reason: 'Private support details for customer@example.com',
    added_by_email: 'original-opt-in-creator@example.com',
    added_at: new Date().toISOString(),
    errors_only: true,
  };
}

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    is_admin: true,
    google_user_email: 'request-logging-admin@example.com',
    google_user_name: 'Request Logging Admin',
  });
  nonAdmin = await insertTestUser();
});

describe('admin.requestLoggingOptIns', () => {
  it('requires admin access for list, create, and delete without changing state or auditing success', async () => {
    const existing = makeOptIn();
    await db.insert(ai_gateway_request_logging_opt_ins).values({ opt_ins: [existing] });
    const caller = await createCallerForUser(nonAdmin.id);

    await expect(caller.admin.requestLoggingOptIns.list()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller.admin.requestLoggingOptIns.create({
        target_type: 'account',
        target_id: nonAdmin.id,
        reason: 'Investigate errors',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.admin.requestLoggingOptIns.delete({ id: existing.id })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(await getRequestLoggingOptIns()).toEqual([existing]);
    expect(await db.select().from(admin_action_audit_logs)).toEqual([]);
  });

  it('lists no opt-ins when the singleton is absent without auditing a write', async () => {
    const caller = await createCallerForUser(admin.id);

    await expect(caller.admin.requestLoggingOptIns.list()).resolves.toEqual([]);
    expect(await db.select().from(admin_action_audit_logs)).toEqual([]);
  });

  it.each(['account', 'organization'] as const)(
    'creates and deletes an %s opt-in with safe actor-attributed audit records',
    async targetType => {
      const caller = await createCallerForUser(admin.id);
      const targetId =
        targetType === 'account' ? 'oauth/request-logging-target' : crypto.randomUUID();
      const reason = 'Private support details for customer@example.com';
      const expiresAt =
        targetType === 'organization'
          ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
          : undefined;
      const created = await caller.admin.requestLoggingOptIns.create({
        target_type: targetType,
        target_id: ` ${targetId} `,
        reason: ` ${reason} `,
        ...(targetType === 'organization' ? { errors_only: true, expires_at: expiresAt } : {}),
      });

      expect(created).toEqual({
        id: expect.any(String),
        target_type: targetType,
        target_id: targetId,
        reason,
        added_by_email: admin.google_user_email,
        added_at: expect.any(String),
        errors_only: targetType === 'organization',
        expires_at: expiresAt,
      });
      expect(await getRequestLoggingOptIns()).toEqual([created]);
      await expect(caller.admin.requestLoggingOptIns.list()).resolves.toEqual([created]);

      const metadata = {
        opt_in_id: created.id,
        errors_only: targetType === 'organization',
        expires_at: expiresAt ?? null,
      };
      const createAudits = await db.select().from(admin_action_audit_logs);
      expect(createAudits).toHaveLength(1);
      expect(createAudits[0]).toMatchObject({
        action: 'request_logging_opt_in.create',
        actor_id: admin.id,
        actor_email: admin.google_user_email,
        actor_name: admin.google_user_name,
        target_type: targetType === 'account' ? 'user' : 'organization',
        target_id: targetId,
        message: 'Enabled API request logging opt-in',
      });
      expect(createAudits[0]?.metadata).toEqual(metadata);

      const deletingAdmin = await insertTestUser({
        is_admin: true,
        google_user_email: 'request-logging-deleting-admin@example.com',
        google_user_name: 'Deleting Admin',
      });
      const deletingCaller = await createCallerForUser(deletingAdmin.id);
      await expect(
        deletingCaller.admin.requestLoggingOptIns.delete({ id: created.id })
      ).resolves.toEqual({ id: created.id });

      expect(await getRequestLoggingOptIns()).toEqual([]);
      const deleteAudits = await db
        .select()
        .from(admin_action_audit_logs)
        .where(eq(admin_action_audit_logs.action, 'request_logging_opt_in.delete'));
      expect(deleteAudits).toHaveLength(1);
      expect(deleteAudits[0]).toMatchObject({
        action: 'request_logging_opt_in.delete',
        actor_id: deletingAdmin.id,
        actor_email: deletingAdmin.google_user_email,
        actor_name: deletingAdmin.google_user_name,
        target_type: targetType === 'account' ? 'user' : 'organization',
        target_id: targetId,
        message: 'Deleted API request logging opt-in',
      });
      expect(deleteAudits[0]?.metadata).toEqual(metadata);
      expect(await db.select().from(admin_action_audit_logs)).toHaveLength(2);
    }
  );

  it.each([
    ['invalid', 'not-a-date'],
    ['non-ISO', '2099-01-01'],
    ['past', '2020-01-01T00:00:00.000Z'],
  ])(
    'rejects an %s expiry without persisting an opt-in or success audit',
    async (_label, expiresAt) => {
      const caller = await createCallerForUser(admin.id);

      await expect(
        caller.admin.requestLoggingOptIns.create({
          target_type: 'account',
          target_id: nonAdmin.id,
          reason: 'Investigate errors',
          expires_at: expiresAt,
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      expect(await db.select().from(ai_gateway_request_logging_opt_ins)).toEqual([]);
      expect(await db.select().from(admin_action_audit_logs)).toEqual([]);
    }
  );

  it('rejects a duplicate with CONFLICT without changing state or auditing success', async () => {
    const existing = makeOptIn();
    await db.insert(ai_gateway_request_logging_opt_ins).values({ opt_ins: [existing] });
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.requestLoggingOptIns.create({
        target_type: existing.target_type,
        target_id: existing.target_id,
        reason: 'A different investigation',
        errors_only: false,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(await getRequestLoggingOptIns()).toEqual([existing]);
    expect(await db.select().from(admin_action_audit_logs)).toEqual([]);
  });

  it('rejects a full active list with BAD_REQUEST without changing state or auditing success', async () => {
    const existing = Array.from({ length: 10 }, () => makeOptIn());
    await db.insert(ai_gateway_request_logging_opt_ins).values({ opt_ins: existing });
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.requestLoggingOptIns.create({
        target_type: 'account',
        target_id: nonAdmin.id,
        reason: 'Investigate errors',
      })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'The limit of 10 active request logging opt-ins has been reached.',
    });

    expect(await getRequestLoggingOptIns()).toEqual(existing);
    expect(await db.select().from(admin_action_audit_logs)).toEqual([]);
  });

  it.each([false, true])(
    'rejects a missing opt-in with NOT_FOUND without auditing success (singleton exists: %s)',
    async singletonExists => {
      const existing = singletonExists ? [makeOptIn()] : [];
      if (singletonExists) {
        await db.insert(ai_gateway_request_logging_opt_ins).values({ opt_ins: existing });
      }
      const caller = await createCallerForUser(admin.id);

      await expect(
        caller.admin.requestLoggingOptIns.delete({ id: crypto.randomUUID() })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      expect(await getRequestLoggingOptIns()).toEqual(existing);
      expect(await db.select().from(admin_action_audit_logs)).toEqual([]);
    }
  );
});

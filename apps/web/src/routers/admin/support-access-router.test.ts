import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { support_access_grant_events, support_access_grants } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { createCallerForUser } from '@/routers/test-utils';

async function insertRequester(overrides: Parameters<typeof insertTestUser>[0] = {}) {
  return insertTestUser({
    is_admin: true,
    is_super_admin: false,
    can_request_support_org_access: true,
    ...overrides,
  });
}

async function insertSuperadmin(overrides: Parameters<typeof insertTestUser>[0] = {}) {
  return insertTestUser({
    is_admin: true,
    is_super_admin: true,
    can_request_support_org_access: true,
    ...overrides,
  });
}

async function orgWithOwner() {
  const owner = await insertTestUser({ is_admin: false });
  const organization = await createTestOrganization(
    `support-access-${crypto.randomUUID()}`,
    owner.id,
    0
  );
  return { owner, organization };
}

function eventsFor(grantId: string) {
  return db.query.support_access_grant_events.findMany({
    where: eq(support_access_grant_events.grant_id, grantId),
  });
}

describe('admin.supportAccess request', () => {
  test('requires the requester permission', async () => {
    const admin = await insertRequester({ can_request_support_org_access: false });
    const { organization } = await orgWithOwner();
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.supportAccess.request({
        organizationId: organization.id,
        actionClass: 'support_read',
        reason: 'investigating a customer report',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('rejects a missing or deleted organization', async () => {
    const requester = await insertRequester();
    const caller = await createCallerForUser(requester.id);

    await expect(
      caller.admin.supportAccess.request({
        organizationId: '00000000-0000-0000-0000-000000000000',
        actionClass: 'support_read',
        reason: 'investigating a customer report',
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('a read request is active immediately and records requested and issued events', async () => {
    const requester = await insertRequester();
    const { organization } = await orgWithOwner();
    const caller = await createCallerForUser(requester.id);

    const grant = await caller.admin.supportAccess.request({
      organizationId: organization.id,
      actionClass: 'support_read',
      reason: 'investigating a customer report',
      ticketReference: 'SUP-123',
    });

    expect(grant.status).toBe('active');
    expect(grant.issuedAt).not.toBeNull();
    expect(grant.expiresAt).not.toBeNull();
    const lifetime = new Date(grant.expiresAt!).getTime() - new Date(grant.issuedAt!).getTime();
    expect(lifetime).toBeLessThanOrEqual(60 * 60 * 1000);

    const events = await eventsFor(grant.id);
    expect(events.map(event => event.event_type).sort()).toEqual(['issued', 'requested']);
  });

  test('a write request is pending and needs a second approver', async () => {
    const requester = await insertRequester();
    const approver = await insertRequester();
    const { organization } = await orgWithOwner();
    const caller = await createCallerForUser(requester.id);

    const grant = await caller.admin.supportAccess.request({
      organizationId: organization.id,
      actionClass: 'support_write',
      reason: 'fixing a broken organization setting',
    });
    expect(grant.status).toBe('pending');
    expect(grant.issuedAt).toBeNull();
    expect(grant.approvedByKiloUserId).toBeNull();

    await expect(caller.admin.supportAccess.approve({ grantId: grant.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    const approverCaller = await createCallerForUser(approver.id);
    const approved = await approverCaller.admin.supportAccess.approve({ grantId: grant.id });
    expect(approved.status).toBe('active');
    expect(approved.approvedByKiloUserId).toBe(approver.id);
    const lifetime =
      new Date(approved.expiresAt!).getTime() - new Date(approved.issuedAt!).getTime();
    expect(lifetime).toBeLessThanOrEqual(15 * 60 * 1000);

    const events = await eventsFor(grant.id);
    expect(events.map(event => event.event_type).sort()).toEqual([
      'approved',
      'issued',
      'requested',
    ]);
  });

  test('concurrent requests produce exactly one open grant', async () => {
    const requester = await insertRequester();
    const { organization } = await orgWithOwner();
    const caller = await createCallerForUser(requester.id);

    const results = await Promise.allSettled([
      caller.admin.supportAccess.request({
        organizationId: organization.id,
        actionClass: 'support_read',
        reason: 'investigating a customer report',
      }),
      caller.admin.supportAccess.request({
        organizationId: organization.id,
        actionClass: 'support_read',
        reason: 'investigating a second customer report',
      }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const open = await db.query.support_access_grants.findMany({
      where: and(
        eq(support_access_grants.actor_kilo_user_id, requester.id),
        eq(support_access_grants.organization_id, organization.id)
      ),
    });
    expect(open).toHaveLength(1);
  });

  test('a stale pending request is expired before a new request is created', async () => {
    const requester = await insertRequester();
    const { organization } = await orgWithOwner();
    const past = new Date(Date.now() - 60_000).toISOString();
    const [stale] = await db
      .insert(support_access_grants)
      .values({
        actor_kilo_user_id: requester.id,
        organization_id: organization.id,
        action_class: 'support_read',
        reason: 'investigating a stale customer report',
        requested_duration_seconds: 1800,
        status: 'pending',
        request_expires_at: past,
      })
      .returning();
    const caller = await createCallerForUser(requester.id);

    const grant = await caller.admin.supportAccess.request({
      organizationId: organization.id,
      actionClass: 'support_read',
      reason: 'investigating a customer report',
    });

    const refreshed = await db.query.support_access_grants.findFirst({
      where: eq(support_access_grants.id, stale.id),
    });
    expect(refreshed?.status).toBe('expired');
    expect(grant.status).toBe('active');
  });
});

describe('admin.supportAccess emergency issue and review', () => {
  test('superadmin issues a 15-minute emergency write grant that needs review', async () => {
    const superadmin = await insertSuperadmin();
    const { organization } = await orgWithOwner();
    const caller = await createCallerForUser(superadmin.id);

    const grant = await caller.admin.supportAccess.emergencyIssue({
      organizationId: organization.id,
      reason: 'production incident mitigation',
    });

    expect(grant.grantKind).toBe('emergency');
    expect(grant.status).toBe('active');
    expect(grant.reviewRequired).toBe(true);
    const lifetime = new Date(grant.expiresAt!).getTime() - new Date(grant.issuedAt!).getTime();
    expect(lifetime).toBeLessThanOrEqual(15 * 60 * 1000);

    await expect(caller.admin.supportAccess.review({ grantId: grant.id })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });

    const reviewer = await insertSuperadmin();
    const reviewerCaller = await createCallerForUser(reviewer.id);
    const reviewed = await reviewerCaller.admin.supportAccess.review({ grantId: grant.id });
    expect(reviewed.reviewedAt).not.toBeNull();
  });

  test('a non-superadmin cannot issue an emergency grant', async () => {
    const requester = await insertRequester();
    const { organization } = await orgWithOwner();
    const caller = await createCallerForUser(requester.id);

    await expect(
      caller.admin.supportAccess.emergencyIssue({
        organizationId: organization.id,
        reason: 'production incident mitigation',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('support grant database invariants', () => {
  test('rejects self-approval, self-review, and over-long windows', async () => {
    const requester = await insertRequester();
    const { organization } = await orgWithOwner();
    const now = new Date();
    const base = {
      actor_kilo_user_id: requester.id,
      organization_id: organization.id,
      reason: 'investigating a customer report',
      requested_duration_seconds: 1800,
    };

    await expect(
      db.insert(support_access_grants).values({
        ...base,
        action_class: 'support_read',
        status: 'active',
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 61 * 60 * 1000).toISOString(),
      })
    ).rejects.toThrow();

    await expect(
      db.insert(support_access_grants).values({
        ...base,
        action_class: 'support_write',
        status: 'active',
        approved_by_kilo_user_id: requester.id,
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
      })
    ).rejects.toThrow();

    await expect(
      db.insert(support_access_grants).values({
        ...base,
        action_class: 'support_read',
        status: 'active',
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
        reviewed_by_kilo_user_id: requester.id,
        review_required: true,
      })
    ).rejects.toThrow();
  });

  test('grant events have no update or delete call sites', () => {
    const servicePath = path.join(__dirname, '../../../src/lib/admin/support-access-service.ts');
    const source = fs.readFileSync(servicePath, 'utf8');
    expect(source).not.toMatch(/\.update\(support_access_grant_events\)/);
    expect(source).not.toMatch(/\.delete\(support_access_grant_events\)/);
  });
});

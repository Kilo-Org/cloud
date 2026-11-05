import { afterAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import {
  passkey_credentials,
  session_step_up_proofs,
  support_access_grant_events,
  support_access_grants,
} from '@kilocode/db/schema';
import { hashWebSessionId } from '@kilocode/web-shared/lib/admin/step-up-store';
import { StepUpRequiredError } from '@kilocode/web-shared/lib/admin/privileged-access';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { createCallerForUser, createSessionCallerForUser } from '@/routers/test-utils';

async function insertRequester(overrides: Parameters<typeof insertTestUser>[0] = {}) {
  return insertTestUser({
    is_admin: true,
    is_super_admin: false,
    ...overrides,
  });
}

async function insertSuperadmin(overrides: Parameters<typeof insertTestUser>[0] = {}) {
  return insertTestUser({
    is_admin: true,
    is_super_admin: true,
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

function constraintName(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current === null || typeof current !== 'object') return null;
    const candidate = current as { constraint?: unknown; cause?: unknown };
    if (typeof candidate.constraint === 'string') return candidate.constraint;
    current = candidate.cause;
  }
  return null;
}

async function expectConstraint(promise: Promise<unknown>, name: string) {
  try {
    await promise;
    throw new Error('Expected the query to violate a check constraint');
  } catch (error) {
    expect(constraintName(error)).toBe(name);
  }
}

function eventsFor(grantId: string) {
  return db.query.support_access_grant_events.findMany({
    where: eq(support_access_grant_events.grant_id, grantId),
  });
}

describe('admin.supportAccess request', () => {
  test('every platform admin can request without an extra permission', async () => {
    const admin = await insertRequester();
    const { organization } = await orgWithOwner();
    const caller = await stepUpCaller(admin.id);

    const grant = await caller.admin.supportAccess.request({
      organizationId: organization.id,
      actionClass: 'support_read',
      reason: 'investigating a customer report',
    });
    expect(grant.status).toBe('active');
  });

  test('rejects a missing or deleted organization', async () => {
    const requester = await insertRequester();
    const caller = await stepUpCaller(requester.id);

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
    const caller = await stepUpCaller(requester.id);

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
    const caller = await stepUpCaller(requester.id);

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

    const approverCaller = await stepUpCaller(approver.id);
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

  test('concurrent approvals of one pending grant produce exactly one success', async () => {
    const requester = await insertRequester();
    const first = await insertRequester();
    const second = await insertRequester();
    const { organization } = await orgWithOwner();
    const pending = await (
      await stepUpCaller(requester.id)
    ).admin.supportAccess.request({
      organizationId: organization.id,
      actionClass: 'support_write',
      reason: 'fixing a broken organization setting',
    });

    const results = await Promise.allSettled([
      (await stepUpCaller(first.id)).admin.supportAccess.approve({
        grantId: pending.id,
      }),
      (await stepUpCaller(second.id)).admin.supportAccess.approve({
        grantId: pending.id,
      }),
    ]);

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'CONFLICT' });
  });

  test('concurrent requests produce exactly one open grant', async () => {
    const requester = await insertRequester();
    const { organization } = await orgWithOwner();
    const caller = await stepUpCaller(requester.id);

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
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'CONFLICT' });
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
    const caller = await stepUpCaller(requester.id);

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
    const caller = await stepUpCaller(superadmin.id);

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
    const reviewerCaller = await stepUpCaller(reviewer.id);
    const reviewed = await reviewerCaller.admin.supportAccess.review({ grantId: grant.id });
    expect(reviewed.reviewedAt).not.toBeNull();
  });

  test('a non-superadmin cannot issue an emergency grant', async () => {
    const requester = await insertRequester();
    const { organization } = await orgWithOwner();
    const caller = await stepUpCaller(requester.id);

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

    await expectConstraint(
      db.insert(support_access_grants).values({
        ...base,
        action_class: 'support_read',
        status: 'active',
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 61 * 60 * 1000).toISOString(),
      }),
      'support_access_grants_duration_cap_check'
    );

    await expectConstraint(
      db.insert(support_access_grants).values({
        ...base,
        action_class: 'support_write',
        status: 'active',
        approved_by_kilo_user_id: requester.id,
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
      }),
      'support_access_grants_approver_not_actor_check'
    );

    await expectConstraint(
      db.insert(support_access_grants).values({
        ...base,
        action_class: 'support_read',
        status: 'active',
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
        reviewed_by_kilo_user_id: requester.id,
        review_required: true,
      }),
      'support_access_grants_reviewer_not_actor_check'
    );
  });

  test('grant events have no update or delete call sites', () => {
    const servicePath = path.join(__dirname, '../../../src/lib/admin/support-access-service.ts');
    const source = fs.readFileSync(servicePath, 'utf8');
    expect(source).not.toMatch(/\.update\(support_access_grant_events\)/);
    expect(source).not.toMatch(/\.delete\(support_access_grant_events\)/);
  });
});

const originalSupportAccess = process.env.SUPPORT_ACCESS_ENABLED;
const originalAdminStepUp = process.env.ADMIN_STEP_UP_ENABLED;

beforeEach(() => {
  process.env.SUPPORT_ACCESS_ENABLED = 'true';
  process.env.ADMIN_STEP_UP_ENABLED = 'true';
});

afterAll(() => {
  if (originalSupportAccess === undefined) delete process.env.SUPPORT_ACCESS_ENABLED;
  else process.env.SUPPORT_ACCESS_ENABLED = originalSupportAccess;
  if (originalAdminStepUp === undefined) delete process.env.ADMIN_STEP_UP_ENABLED;
  else process.env.ADMIN_STEP_UP_ENABLED = originalAdminStepUp;
});

const supportStepUpSessionId = 'support-access-step-up-test';

async function grantFreshStepUp(userId: string) {
  const [credential] = await db
    .insert(passkey_credentials)
    .values({
      kilo_user_id: userId,
      credential_id: `support-step-up-${crypto.randomUUID()}`,
      public_key: 'unused-public-key',
    })
    .returning();
  const now = new Date();
  await db.insert(session_step_up_proofs).values({
    kilo_user_id: userId,
    session_id_hash: hashWebSessionId(supportStepUpSessionId),
    method: 'webauthn_uv',
    passkey_credential_id: credential!.id,
    purpose: 'session',
    verified_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 15 * 60_000).toISOString(),
  });
}

async function stepUpCaller(userId: string) {
  await grantFreshStepUp(userId);
  return createSessionCallerForUser(userId, { webSessionId: supportStepUpSessionId });
}

function enableSupportAccessForStepUp(enabled: boolean) {
  if (enabled) process.env.SUPPORT_ACCESS_ENABLED = 'true';
  else delete process.env.SUPPORT_ACCESS_ENABLED;
}

function setAdminStepUp(enabled: boolean) {
  if (enabled) process.env.ADMIN_STEP_UP_ENABLED = 'true';
  else delete process.env.ADMIN_STEP_UP_ENABLED;
}

describe('support write step-up', () => {
  const originalSupport = process.env.SUPPORT_ACCESS_ENABLED;
  const originalAdminStepUp = process.env.ADMIN_STEP_UP_ENABLED;

  afterEach(() => {
    if (originalSupport === undefined) delete process.env.SUPPORT_ACCESS_ENABLED;
    else process.env.SUPPORT_ACCESS_ENABLED = originalSupport;
    if (originalAdminStepUp === undefined) delete process.env.ADMIN_STEP_UP_ENABLED;
    else process.env.ADMIN_STEP_UP_ENABLED = originalAdminStepUp;
  });

  test('ON with admin step-up off refuses write request, approval, and emergency issue', async () => {
    enableSupportAccessForStepUp(true);
    setAdminStepUp(false);
    const requester = await insertRequester();
    const approver = await insertRequester();
    const superadmin = await insertSuperadmin();
    const { organization, owner } = await orgWithOwner();

    await expect(
      (await stepUpCaller(requester.id)).admin.supportAccess.request({
        organizationId: organization.id,
        actionClass: 'support_write',
        reason: 'fixing a broken organization setting',
      })
    ).rejects.toThrow('Step-up must be enabled');

    // Read grants do not need step-up.
    const read = await (
      await stepUpCaller(requester.id)
    ).admin.supportAccess.request({
      organizationId: organization.id,
      actionClass: 'support_read',
      reason: 'investigating a customer report',
    });
    expect(read.status).toBe('active');

    const [directPending] = await db
      .insert(support_access_grants)
      .values({
        actor_kilo_user_id: owner.id,
        organization_id: organization.id,
        action_class: 'support_write',
        status: 'pending',
        reason: 'direct pending grant for step-up test',
        requested_duration_seconds: 600,
        request_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
      })
      .returning();

    await expect(
      (await stepUpCaller(approver.id)).admin.supportAccess.approve({
        grantId: directPending!.id,
      })
    ).rejects.toThrow('Step-up must be enabled');

    await expect(
      (await stepUpCaller(superadmin.id)).admin.supportAccess.emergencyIssue({
        organizationId: organization.id,
        reason: 'production incident mitigation',
      })
    ).rejects.toThrow('Step-up must be enabled');
  });

  test('ON with admin step-up on accepts write request, approval, and emergency issue with fresh proofs', async () => {
    enableSupportAccessForStepUp(true);
    setAdminStepUp(true);
    const requester = await insertRequester();
    const approver = await insertRequester();
    const superadmin = await insertSuperadmin();
    const { organization } = await orgWithOwner();

    const pending = await (
      await stepUpCaller(requester.id)
    ).admin.supportAccess.request({
      organizationId: organization.id,
      actionClass: 'support_write',
      reason: 'fixing a broken organization setting',
    });
    expect(pending.status).toBe('pending');

    const approved = await (
      await stepUpCaller(approver.id)
    ).admin.supportAccess.approve({
      grantId: pending.id,
    });
    expect(approved.status).toBe('active');

    const emergency = await (
      await stepUpCaller(superadmin.id)
    ).admin.supportAccess.emergencyIssue({
      organizationId: organization.id,
      reason: 'production incident mitigation',
    });
    expect(emergency.status).toBe('active');
  });
});

describe('support access lifecycle switch and step-up failures', () => {
  test('OFF refuses every lifecycle mutation and makes no step-up calls', async () => {
    delete process.env.SUPPORT_ACCESS_ENABLED;
    delete process.env.ADMIN_STEP_UP_ENABLED;
    const { supportStepUpPort } = await import('@kilocode/web-shared/lib/admin/support-step-up');
    const stepUpSpy = jest.spyOn(supportStepUpPort, 'requireFresh');
    const admin = await insertRequester();
    const caller = await createCallerForUser(admin.id);
    const { organization } = await orgWithOwner();
    const grantId = crypto.randomUUID();

    const calls = [
      () =>
        caller.admin.supportAccess.request({
          organizationId: organization.id,
          actionClass: 'support_write',
          reason: 'fixing a broken organization setting',
        }),
      () => caller.admin.supportAccess.approve({ grantId }),
      () => caller.admin.supportAccess.deny({ grantId }),
      () => caller.admin.supportAccess.cancel({ grantId }),
      () =>
        caller.admin.supportAccess.emergencyIssue({
          organizationId: organization.id,
          reason: 'production incident mitigation',
        }),
      () => caller.admin.supportAccess.review({ grantId }),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        code: 'FORBIDDEN',
        cause: expect.objectContaining({ supportAccessReason: 'support_access_disabled' }),
      });
    }
    expect(stepUpSpy).not.toHaveBeenCalled();
    stepUpSpy.mockRestore();
  });

  test('ON refuses a bearer write request even with step-up enabled', async () => {
    const admin = await insertRequester();
    const { organization } = await orgWithOwner();
    const caller = await createCallerForUser(admin.id);

    await expect(
      caller.admin.supportAccess.request({
        organizationId: organization.id,
        actionClass: 'support_write',
        reason: 'fixing a broken organization setting',
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.any(StepUpRequiredError),
    });
  });

  test('ON with an enrolled session but no fresh proof returns MFA_REQUIRED', async () => {
    const admin = await insertRequester();
    const { organization } = await orgWithOwner();
    // A passkey exists, but no proof for this session: the guard distinguishes
    // this from "not enrolled".
    await db.insert(passkey_credentials).values({
      kilo_user_id: admin.id,
      credential_id: `support-no-proof-${crypto.randomUUID()}`,
      public_key: 'unused-public-key',
    });
    const caller = await createSessionCallerForUser(admin.id, {
      webSessionId: 'support-access-no-proof',
    });

    await expect(
      caller.admin.supportAccess.request({
        organizationId: organization.id,
        actionClass: 'support_write',
        reason: 'fixing a broken organization setting',
      })
    ).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ code: 'MFA_REQUIRED' }),
    });
  });
});

describe('admin.supportAccess viewAccess', () => {
  test('a non-member admin without a grant must request access', async () => {
    const admin = await insertRequester();
    const { organization } = await orgWithOwner();
    const caller = await stepUpCaller(admin.id);

    await expect(
      caller.admin.supportAccess.viewAccess({ organizationId: organization.id })
    ).resolves.toEqual({ grantRequired: true, expiresAt: null });
  });

  test('an active own read grant lets the admin open the organization', async () => {
    const admin = await insertRequester();
    const { organization } = await orgWithOwner();
    const caller = await stepUpCaller(admin.id);
    const grant = await caller.admin.supportAccess.request({
      organizationId: organization.id,
      actionClass: 'support_read',
      reason: 'investigating a customer report',
    });

    await expect(
      caller.admin.supportAccess.viewAccess({ organizationId: organization.id })
    ).resolves.toEqual({ grantRequired: false, expiresAt: grant.expiresAt });
  });

  test("another admin's grant does not count", async () => {
    const holder = await insertRequester();
    const other = await insertRequester();
    const { organization } = await orgWithOwner();
    await (
      await stepUpCaller(holder.id)
    ).admin.supportAccess.request({
      organizationId: organization.id,
      actionClass: 'support_read',
      reason: 'investigating a customer report',
    });

    await expect(
      (await stepUpCaller(other.id)).admin.supportAccess.viewAccess({
        organizationId: organization.id,
      })
    ).resolves.toEqual({ grantRequired: true, expiresAt: null });
  });

  test('an admin who is a member needs no grant', async () => {
    const admin = await insertRequester();
    const organization = await createTestOrganization(
      `support-access-${crypto.randomUUID()}`,
      admin.id,
      0
    );
    const caller = await stepUpCaller(admin.id);

    await expect(
      caller.admin.supportAccess.viewAccess({ organizationId: organization.id })
    ).resolves.toEqual({ grantRequired: false, expiresAt: null });
  });

  test('no grant is required while support access is off', async () => {
    delete process.env.SUPPORT_ACCESS_ENABLED;
    const admin = await insertRequester();
    const { organization } = await orgWithOwner();
    const caller = await stepUpCaller(admin.id);

    await expect(
      caller.admin.supportAccess.viewAccess({ organizationId: organization.id })
    ).resolves.toEqual({ grantRequired: false, expiresAt: null });
  });
});

describe('admin.supportAccess list display names', () => {
  test('active grants include the organization name and holder details', async () => {
    const admin = await insertRequester();
    const { organization } = await orgWithOwner();
    const caller = await stepUpCaller(admin.id);
    const grant = await caller.admin.supportAccess.request({
      organizationId: organization.id,
      actionClass: 'support_read',
      reason: 'investigating a customer report',
    });

    const active = await caller.admin.supportAccess.listActive();
    const listed = active.find(item => item.id === grant.id);

    expect(listed).toMatchObject({
      organizationId: organization.id,
      organizationName: organization.name,
      actor: { id: admin.id, name: admin.google_user_name, email: admin.google_user_email },
      approvedBy: null,
    });
  });
});

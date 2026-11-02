import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  ensureOrganizationAccess,
  ensureMemberOrganizationAccess,
  ensureOrganizationAccessAndFetchOrg,
  ensureOrganizationsAccess,
  getOrganizationsAccessRoles,
} from './utils';
import {
  setAdminAccessSinkForTest,
  type AdminAccessEvent,
} from '@kilocode/web-shared/lib/admin/admin-access-log';
import type { TRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  organization_memberships,
  organizations,
  support_access_grant_events,
  support_access_grants,
  type User,
} from '@kilocode/db/schema';
import { setSupportAccessModeForTest } from '@kilocode/web-shared/lib/admin/support-access';
import { eq } from 'drizzle-orm';

/**
 * `is_admin` on these helpers is the escape hatch that lets a Kilo employee read
 * any customer organization from a plain `baseProcedure`. It bypasses both
 * `admin_access` guard choke points, so the audit trail depends entirely on the
 * `kilo_admin_elevation` emit inside each branch.
 */
describe('organization access kilo_admin_elevation telemetry', () => {
  let events: AdminAccessEvent[];

  beforeEach(() => {
    events = [];
    setAdminAccessSinkForTest(event => events.push(event));
  });

  afterEach(async () => {
    setAdminAccessSinkForTest(null);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_memberships);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  function ctxFor(user: User): TRPCContext {
    return {
      user,
      authViaToken: true,
      tokenSource: 'cloud-agent',
      ip: '203.0.113.7',
      trpcPath: 'organizations.getSettings',
      trpcType: 'query',
    };
  }

  async function orgOwnedByAnotherUser() {
    const owner = await insertTestUser({ is_admin: false });
    return createTestOrganization(`elevation-test-${crypto.randomUUID()}`, owner.id, 0);
  }

  async function softDeleteOrganization(organizationId: string) {
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organizationId));
  }

  describe('admin access to organizations marked deleted', () => {
    test('an admin elevation never applies to a deleted organization', async () => {
      const admin = await insertTestUser({ is_admin: true });
      const organization = await orgOwnedByAnotherUser();
      await softDeleteOrganization(organization.id);

      await expect(ensureOrganizationAccess(ctxFor(admin), organization.id)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await expect(
        ensureOrganizationAccessAndFetchOrg(ctxFor(admin), organization.id)
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      // The fetch helper attributes the attempt before resolving it; the
      // access helper records nothing because no elevation was granted.
      const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
      expect(elevationEvents).toHaveLength(1);
      expect(elevationEvents[0]).toMatchObject({ reason: 'organization_fetch' });
    });

    test('a batched admin resolution elevates only live organizations', async () => {
      const admin = await insertTestUser({ is_admin: true });
      const active = await orgOwnedByAnotherUser();
      const alsoActive = await orgOwnedByAnotherUser();
      const deleted = await orgOwnedByAnotherUser();
      await softDeleteOrganization(deleted.id);

      const roles = await getOrganizationsAccessRoles(ctxFor(admin), [
        active.id,
        alsoActive.id,
        deleted.id,
      ]);

      expect(roles.get(active.id)).toBe('owner');
      expect(roles.get(alsoActive.id)).toBe('owner');
      expect(roles.has(deleted.id)).toBe(false);
      const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
      expect(elevationEvents).toHaveLength(1);
      expect(elevationEvents[0]).toMatchObject({
        reason: 'organization_access_batch',
        target: 'organizations:2',
      });
    });

    test('a batched admin resolution records no elevation when every organization is deleted', async () => {
      const admin = await insertTestUser({ is_admin: true });
      const deleted = await orgOwnedByAnotherUser();
      await softDeleteOrganization(deleted.id);

      const roles = await getOrganizationsAccessRoles(ctxFor(admin), [deleted.id]);

      expect(roles.size).toBe(0);
      expect(events).toHaveLength(0);
    });

    test('the batched guard rejects a request that names a deleted organization', async () => {
      const admin = await insertTestUser({ is_admin: true });
      const active = await orgOwnedByAnotherUser();
      const deleted = await orgOwnedByAnotherUser();
      await softDeleteOrganization(deleted.id);

      await expect(
        ensureOrganizationsAccess(ctxFor(admin), [active.id, deleted.id])
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
      await expect(ensureOrganizationsAccess(ctxFor(admin), [active.id])).resolves.toBeUndefined();
    });
  });

  test('ensureOrganizationAccess records the org an admin reached without membership', async () => {
    const admin = await insertTestUser({ is_admin: true, is_super_admin: true });
    const organization = await orgOwnedByAnotherUser();

    await expect(ensureOrganizationAccess(ctxFor(admin), organization.id)).resolves.toBe('owner');

    const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
    expect(elevationEvents).toHaveLength(1);
    expect(elevationEvents[0]).toMatchObject({
      event: 'admin_access',
      surface: 'trpc',
      kind: 'kilo_admin_elevation',
      kiloUserId: admin.id,
      adminTier: 'super_admin',
      authVia: 'token',
      tokenSource: 'cloud-agent',
      route: 'organizations.getSettings',
      method: 'query',
      ip: '203.0.113.7',
      reason: 'organization_access',
      target: `organization:${organization.id}`,
    });
  });

  test('ensureOrganizationAccess does not label a REST caller as a tRPC request', async () => {
    // Route handlers such as `/api/cloud-agent/sessions/stream-ticket` and
    // `/api/auto-routing/custom-routers` call this helper with a hand-rolled
    // `{ user }`. Labelling those `surface:"trpc"`/`authVia:"session"` would
    // hide a token-authenticated admin read behind a web-console-looking event.
    const admin = await insertTestUser({ is_admin: true });
    const organization = await orgOwnedByAnotherUser();

    await expect(ensureOrganizationAccess({ user: admin }, organization.id)).resolves.toBe('owner');

    const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
    expect(elevationEvents).toHaveLength(1);
    expect(elevationEvents[0]).toMatchObject({
      surface: 'rest',
      kind: 'kilo_admin_elevation',
      kiloUserId: admin.id,
      route: null,
      method: null,
      reason: 'organization_access',
      target: `organization:${organization.id}`,
    });
  });

  function failMembershipQueries() {
    const originalSelect = db.select.bind(db);
    return jest.spyOn(db, 'select').mockImplementation((...args) => {
      const builder = originalSelect(...args);
      return new Proxy(builder, {
        get(target, property, receiver) {
          if (property === 'from') {
            return (table: Parameters<typeof target.from>[0]) => {
              if (table === organization_memberships) {
                throw new Error('membership query failed');
              }
              return target.from(table);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
  }

  test('a membership observation failure never fails the admin request', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const organization = await orgOwnedByAnotherUser();

    const selectSpy = failMembershipQueries();
    try {
      await expect(ensureOrganizationAccess(ctxFor(admin), organization.id)).resolves.toBe('owner');
    } finally {
      selectSpy.mockRestore();
    }

    expect(events.find(event => event.kind === 'kilo_admin_elevation')).toMatchObject({
      kind: 'kilo_admin_elevation',
      membershipRole: null,
      wouldPassWithoutAdmin: null,
    });
  });

  test('a membership observation failure never fails the batch admin request', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const organization = await orgOwnedByAnotherUser();

    const selectSpy = failMembershipQueries();
    let roles: Map<string, string>;
    try {
      roles = await getOrganizationsAccessRoles(ctxFor(admin), [organization.id]);
    } finally {
      selectSpy.mockRestore();
    }

    expect(roles.get(organization.id)).toBe('owner');
    expect(events.find(event => event.kind === 'kilo_admin_elevation')).toMatchObject({
      kind: 'kilo_admin_elevation',
      membershipRole: null,
      wouldPassWithoutAdmin: null,
    });
  });

  test('ensureOrganizationAccess stays silent for a member resolving their own org', async () => {
    const member = await insertTestUser({ is_admin: false });
    const organization = await createTestOrganization(
      `elevation-test-${crypto.randomUUID()}`,
      member.id,
      0
    );

    await expect(ensureOrganizationAccess(ctxFor(member), organization.id)).resolves.toBe('owner');

    expect(events).toHaveLength(0);
  });

  test('getOrganizationsAccessRoles records one event carrying the batch breadth', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const first = await orgOwnedByAnotherUser();
    const second = await orgOwnedByAnotherUser();

    const roles = await getOrganizationsAccessRoles(ctxFor(admin), [
      first.id,
      second.id,
      second.id,
    ]);

    expect(roles.get(first.id)).toBe('owner');
    expect(roles.get(second.id)).toBe('owner');
    const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
    expect(elevationEvents).toHaveLength(1);
    expect(elevationEvents[0]).toMatchObject({
      kind: 'kilo_admin_elevation',
      reason: 'organization_access_batch',
      target: 'organizations:2',
    });
  });

  test('ensureOrganizationAccessAndFetchOrg records the org an admin fetched', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const organization = await orgOwnedByAnotherUser();

    const fetched = await ensureOrganizationAccessAndFetchOrg(ctxFor(admin), organization.id);

    expect(fetched.id).toBe(organization.id);
    const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
    expect(elevationEvents).toHaveLength(1);
    expect(elevationEvents[0]).toMatchObject({
      kind: 'kilo_admin_elevation',
      reason: 'organization_fetch',
      target: `organization:${organization.id}`,
    });
  });

  test('ensureOrganizationAccessAndFetchOrg records an admin probing a missing org', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const missingId = crypto.randomUUID();

    await expect(ensureOrganizationAccessAndFetchOrg(ctxFor(admin), missingId)).rejects.toThrow(
      /Organization not found/
    );

    const elevationEvents = events.filter(event => event.kind === 'kilo_admin_elevation');
    expect(elevationEvents).toHaveLength(1);
    expect(elevationEvents[0]).toMatchObject({
      reason: 'organization_fetch',
      target: `organization:${missingId}`,
    });
  });

  test('denies direct membership in a soft-deleted organization', async () => {
    const member = await insertTestUser();
    const organization = await createTestOrganization(
      `deleted-direct-${crypto.randomUUID()}`,
      member.id,
      0
    );
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organization.id));

    await expect(ensureOrganizationAccess(ctxFor(member), organization.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const roles = await getOrganizationsAccessRoles(ctxFor(member), [organization.id]);
    expect(roles.has(organization.id)).toBe(false);
    await expect(
      ensureOrganizationAccessAndFetchOrg(ctxFor(member), organization.id)
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('keeps parent-inherited access while the target and parent are live', async () => {
    const parentOwner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createTestOrganization(
      `live-parent-${crypto.randomUUID()}`,
      parentOwner.id,
      0
    );
    const child = await createTestOrganization(
      `live-child-${crypto.randomUUID()}`,
      childOwner.id,
      0
    );
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));

    await expect(ensureOrganizationAccess(ctxFor(parentOwner), child.id)).resolves.toBe('owner');
    await expect(getOrganizationsAccessRoles(ctxFor(parentOwner), [child.id])).resolves.toEqual(
      new Map([[child.id, 'owner']])
    );
  });

  test('denies inherited access when the target organization is soft-deleted', async () => {
    const parentOwner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createTestOrganization(`parent-${crypto.randomUUID()}`, parentOwner.id, 0);
    const child = await createTestOrganization(
      `deleted-child-${crypto.randomUUID()}`,
      childOwner.id,
      0
    );
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id, deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, child.id));

    await expect(ensureOrganizationAccess(ctxFor(parentOwner), child.id)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  test('denies inherited access when the parent organization is soft-deleted', async () => {
    const parentOwner = await insertTestUser();
    const childOwner = await insertTestUser();
    const parent = await createTestOrganization(
      `deleted-parent-${crypto.randomUUID()}`,
      parentOwner.id,
      0
    );
    const child = await createTestOrganization(`child-${crypto.randomUUID()}`, childOwner.id, 0);
    await db
      .update(organizations)
      .set({ parent_organization_id: parent.id })
      .where(eq(organizations.id, child.id));
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, parent.id));

    await expect(ensureOrganizationAccess(ctxFor(parentOwner), child.id)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });
});

describe('mode-aware support organization access', () => {
  let events: AdminAccessEvent[];

  beforeEach(() => {
    events = [];
    setAdminAccessSinkForTest(event => events.push(event));
  });

  afterEach(async () => {
    setSupportAccessModeForTest(null);
    setAdminAccessSinkForTest(null);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(support_access_grant_events);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(support_access_grants);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_memberships);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  async function orgAndAdmin() {
    const owner = await insertTestUser({ is_admin: false });
    const organization = await createTestOrganization(
      `support-mode-${crypto.randomUUID()}`,
      owner.id,
      0
    );
    const admin = await insertTestUser({
      is_admin: true,
      can_request_support_org_access: true,
    });
    return { organization, admin };
  }

  async function insertGrant(params: {
    actorKiloUserId: string;
    organizationId: string;
    actionClass: 'support_read' | 'support_write';
    approverKiloUserId?: string;
  }) {
    const now = new Date();
    const [grant] = await db
      .insert(support_access_grants)
      .values({
        actor_kilo_user_id: params.actorKiloUserId,
        organization_id: params.organizationId,
        action_class: params.actionClass,
        status: 'active',
        reason: 'investigating a customer report',
        requested_duration_seconds: 1800,
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
        approved_by_kilo_user_id: params.approverKiloUserId ?? null,
      })
      .returning();
    return grant;
  }

  function readCtx(user: User): TRPCContext {
    return {
      user,
      trpcPath: 'organizations.usageStats',
      trpcType: 'query',
    };
  }

  test('observe keeps the legacy owner shortcut and records the support decision', async () => {
    setSupportAccessModeForTest('observe');
    const { organization, admin } = await orgAndAdmin();

    await expect(ensureOrganizationAccess(readCtx(admin), organization.id)).resolves.toBe('owner');

    const event = events.find(event => event.kind === 'kilo_admin_elevation');
    expect(event).toMatchObject({ supportDecision: 'deny_no_grant' });
  });

  test('observe records an allowlisted grant but still returns the legacy owner role', async () => {
    setSupportAccessModeForTest('observe');
    const { organization, admin } = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_read',
    });

    await expect(ensureOrganizationAccess(readCtx(admin), organization.id)).resolves.toBe('owner');

    const event = events.find(event => event.kind === 'kilo_admin_elevation');
    expect(event).toMatchObject({ supportDecision: 'support_grant' });
  });

  test('observe records a non-allowlisted grant as a denial without changing access', async () => {
    setSupportAccessModeForTest('observe');
    const { organization, admin } = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_read',
    });

    await expect(
      ensureOrganizationAccess(
        { ...readCtx(admin), trpcPath: 'organizations.getSettings' },
        organization.id
      )
    ).resolves.toBe('owner');

    const event = events.find(event => event.kind === 'kilo_admin_elevation');
    expect(event).toMatchObject({ supportDecision: 'deny_not_allowlisted' });
  });

  test('observe records a real owner as passing without the admin shortcut', async () => {
    setSupportAccessModeForTest('observe');
    const { organization, admin } = await orgAndAdmin();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: admin.id,
      role: 'owner',
      invited_by: 'test',
    });

    await expect(ensureOrganizationAccess(readCtx(admin), organization.id)).resolves.toBe('owner');
    const event = events.find(event => event.kind === 'kilo_admin_elevation');
    expect(event).toMatchObject({
      membershipRole: 'owner',
      wouldPassWithoutAdmin: true,
      supportDecision: 'member',
    });
  });

  test('observe records a real member without the required role as a denial', async () => {
    setSupportAccessModeForTest('observe');
    const { organization, admin } = await orgAndAdmin();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: admin.id,
      role: 'member',
      invited_by: 'test',
    });

    await expect(
      ensureOrganizationAccess(readCtx(admin), organization.id, ['owner'])
    ).resolves.toBe('owner');
    const event = events.find(event => event.kind === 'kilo_admin_elevation');
    expect(event).toMatchObject({
      membershipRole: 'member',
      wouldPassWithoutAdmin: false,
      supportDecision: 'deny_actor_permission',
    });
  });

  test('member-only admits an admin who really holds the role', async () => {
    const { organization, admin } = await orgAndAdmin();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: admin.id,
      role: 'owner',
      invited_by: 'test',
    });

    for (const mode of ['off', 'observe', 'enforce'] as const) {
      setSupportAccessModeForTest(mode);
      await expect(ensureMemberOrganizationAccess({ id: admin.id }, organization.id)).resolves.toBe(
        'owner'
      );
    }
  });

  test('enforce picks the write grant even when a longer read grant exists', async () => {
    setSupportAccessModeForTest('enforce');
    const { organization, admin } = await orgAndAdmin();
    const approver = await insertTestUser({ is_admin: true });
    const now = new Date();
    await db.insert(support_access_grants).values({
      actor_kilo_user_id: admin.id,
      organization_id: organization.id,
      action_class: 'support_read',
      status: 'active',
      reason: 'investigating a customer report',
      requested_duration_seconds: 3600,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
    });
    await db.insert(support_access_grants).values({
      actor_kilo_user_id: admin.id,
      organization_id: organization.id,
      action_class: 'support_write',
      status: 'active',
      reason: 'investigating a customer report',
      requested_duration_seconds: 600,
      approved_by_kilo_user_id: approver.id,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 10 * 60 * 1000).toISOString(),
    });

    await expect(
      ensureOrganizationAccess(
        {
          user: admin,
          trpcPath: 'organizations.settings.updateDefaultModel',
          trpcType: 'mutation',
        },
        organization.id
      )
    ).resolves.toBe('admin');
  });

  test('enforce denies an admin without a grant', async () => {
    setSupportAccessModeForTest('enforce');
    const { organization, admin } = await orgAndAdmin();

    await expect(ensureOrganizationAccess(readCtx(admin), organization.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ supportAccessReason: 'support_grant_required' }),
    });
  });

  test('enforce admits an allowlisted read with the member stand-in role', async () => {
    setSupportAccessModeForTest('enforce');
    const { organization, admin } = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_read',
    });

    await expect(ensureOrganizationAccess(readCtx(admin), organization.id)).resolves.toBe('member');
    const event = events.find(event => event.kind === 'kilo_admin_elevation');
    expect(event).toMatchObject({ supportDecision: 'support_grant' });
  });

  test('enforce admits an allowlisted write only with a write grant', async () => {
    setSupportAccessModeForTest('enforce');
    const { organization, admin } = await orgAndAdmin();
    const approver = await insertTestUser({ is_admin: true });
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_write',
      approverKiloUserId: approver.id,
    });
    const writeCtx: TRPCContext = {
      user: admin,
      trpcPath: 'organizations.settings.updateDefaultModel',
      trpcType: 'mutation',
    };

    await expect(ensureOrganizationAccess(writeCtx, organization.id)).resolves.toBe('admin');
  });

  test('enforce denies a support read grant on a write procedure', async () => {
    setSupportAccessModeForTest('enforce');
    const { organization, admin } = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_read',
    });

    await expect(
      ensureOrganizationAccess(
        {
          user: admin,
          trpcPath: 'organizations.settings.updateDefaultModel',
          trpcType: 'mutation',
        },
        organization.id
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  test('member-only never admits a support grant', async () => {
    setSupportAccessModeForTest('enforce');
    const { organization, admin } = await orgAndAdmin();
    await insertGrant({
      actorKiloUserId: admin.id,
      organizationId: organization.id,
      actionClass: 'support_read',
    });

    await expect(
      ensureMemberOrganizationAccess({ id: admin.id }, organization.id)
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  test('off mode records no support decision for an admin who is a real member', async () => {
    setSupportAccessModeForTest('off');
    const { organization, admin } = await orgAndAdmin();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: admin.id,
      role: 'owner',
      invited_by: 'test',
    });

    await expect(ensureOrganizationAccess(readCtx(admin), organization.id)).resolves.toBe('owner');
    const event = events.find(event => event.kind === 'kilo_admin_elevation');
    expect(event).toMatchObject({
      membershipRole: 'owner',
      wouldPassWithoutAdmin: true,
      supportDecision: null,
    });
  });

  test('a real member keeps access in every mode', async () => {
    setSupportAccessModeForTest('enforce');
    const owner = await insertTestUser({ is_admin: false });
    const organization = await createTestOrganization(
      `support-member-${crypto.randomUUID()}`,
      owner.id,
      0
    );

    await expect(ensureOrganizationAccess({ user: owner }, organization.id)).resolves.toBe('owner');
  });

  test('an expired grant denies in enforce and reports the specific cause', async () => {
    setSupportAccessModeForTest('enforce');
    const { organization, admin } = await orgAndAdmin();
    const issued = new Date(Date.now() - 60 * 60 * 1000);
    const expires = new Date(Date.now() - 30 * 60 * 1000);
    await db.insert(support_access_grants).values({
      actor_kilo_user_id: admin.id,
      organization_id: organization.id,
      action_class: 'support_read',
      status: 'expired',
      reason: 'investigating a customer report',
      requested_duration_seconds: 1800,
      requested_at: issued.toISOString(),
      issued_at: issued.toISOString(),
      expires_at: expires.toISOString(),
    });

    await expect(ensureOrganizationAccess(readCtx(admin), organization.id)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      cause: expect.objectContaining({ supportAccessReason: 'support_grant_expired' }),
    });
  });
});

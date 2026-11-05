import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import {
  ensureOrganizationAccess,
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
import { organization_memberships, organizations, type User } from '@kilocode/db/schema';
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

  test('batch observation honors required roles instead of any membership', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const organization = await orgOwnedByAnotherUser();
    await db.insert(organization_memberships).values({
      organization_id: organization.id,
      kilo_user_id: admin.id,
      role: 'member',
    });

    await getOrganizationsAccessRoles(ctxFor(admin), [organization.id], ['owner']);

    expect(events.find(event => event.kind === 'kilo_admin_elevation')).toMatchObject({
      kind: 'kilo_admin_elevation',
      reason: 'organization_access_batch',
      membershipRole: null,
      wouldPassWithoutAdmin: false,
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
    const fetched = await ensureOrganizationAccessAndFetchOrg(ctxFor(parentOwner), child.id);
    expect(fetched.id).toBe(child.id);
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

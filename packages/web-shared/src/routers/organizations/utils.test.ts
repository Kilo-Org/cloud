import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  ensureOrganizationAccess,
  ensureOrganizationAccessAndFetchOrg,
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

  describe('access resolution for organizations marked deleted', () => {
    test('a direct member gets no access to a deleted organization', async () => {
      const member = await insertTestUser({ is_admin: false });
      const organization = await createTestOrganization(
        `deleted-test-${crypto.randomUUID()}`,
        member.id,
        0
      );
      await softDeleteOrganization(organization.id);

      await expect(ensureOrganizationAccess(ctxFor(member), organization.id)).rejects.toThrow(
        'You do not have access to this organization'
      );
      await expect(
        ensureOrganizationAccessAndFetchOrg(ctxFor(member), organization.id)
      ).rejects.toThrow('You do not have access to this organization');

      const roles = await getOrganizationsAccessRoles(ctxFor(member), [organization.id]);
      expect(roles.has(organization.id)).toBe(false);
    });

    test('a parent-organization owner gets no access to a deleted child', async () => {
      const parentOwner = await insertTestUser({ is_admin: false });
      const parent = await createTestOrganization(
        `deleted-parent-${crypto.randomUUID()}`,
        parentOwner.id,
        0
      );
      const childOwner = await insertTestUser({ is_admin: false });
      const child = await createTestOrganization(
        `deleted-child-${crypto.randomUUID()}`,
        childOwner.id,
        0
      );
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, child.id));
      await softDeleteOrganization(child.id);

      await expect(ensureOrganizationAccess(ctxFor(parentOwner), child.id)).rejects.toThrow(
        'You do not have access to this organization'
      );

      // The same child while active stays accessible through the parent.
      await db
        .update(organizations)
        .set({ deleted_at: null })
        .where(eq(organizations.id, child.id));
      await expect(ensureOrganizationAccess(ctxFor(parentOwner), child.id)).resolves.toBe('owner');
    });

    test('access fails closed when the parent organization is deleted', async () => {
      const parentOwner = await insertTestUser({ is_admin: false });
      const parent = await createTestOrganization(
        `deleted-parent-${crypto.randomUUID()}`,
        parentOwner.id,
        0
      );
      const childOwner = await insertTestUser({ is_admin: false });
      const child = await createTestOrganization(`child-${crypto.randomUUID()}`, childOwner.id, 0);
      await db
        .update(organizations)
        .set({ parent_organization_id: parent.id })
        .where(eq(organizations.id, child.id));
      await softDeleteOrganization(parent.id);

      await expect(ensureOrganizationAccess(ctxFor(parentOwner), child.id)).rejects.toThrow(
        'You do not have access to this organization'
      );
    });

    test('a Kilo admin gets no access to a deleted organization', async () => {
      const admin = await insertTestUser({ is_admin: true });
      const organization = await orgOwnedByAnotherUser();
      await softDeleteOrganization(organization.id);

      await expect(ensureOrganizationAccess(ctxFor(admin), organization.id)).rejects.toThrow(
        'You do not have access to this organization'
      );
      await expect(
        ensureOrganizationAccessAndFetchOrg(ctxFor(admin), organization.id)
      ).rejects.toThrow('Organization not found');

      const roles = await getOrganizationsAccessRoles(ctxFor(admin), [organization.id]);
      expect(roles.has(organization.id)).toBe(false);
      // The only recorded event is the pre-fetch attribution from
      // `ensureOrganizationAccessAndFetchOrg`; no access elevation fired.
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ reason: 'organization_fetch' });
    });

    test('a batched admin role resolution leaves deleted orgs out of the map', async () => {
      const admin = await insertTestUser({ is_admin: true });
      const active = await orgOwnedByAnotherUser();
      const deleted = await orgOwnedByAnotherUser();
      await softDeleteOrganization(deleted.id);

      const roles = await getOrganizationsAccessRoles(ctxFor(admin), [active.id, deleted.id]);

      expect(roles.get(active.id)).toBe('owner');
      expect(roles.has(deleted.id)).toBe(false);
    });

    test('access to active organizations is unchanged', async () => {
      const member = await insertTestUser({ is_admin: false });
      const organization = await createTestOrganization(
        `active-test-${crypto.randomUUID()}`,
        member.id,
        0
      );

      await expect(ensureOrganizationAccess(ctxFor(member), organization.id)).resolves.toBe(
        'owner'
      );
      const fetched = await ensureOrganizationAccessAndFetchOrg(ctxFor(member), organization.id);
      expect(fetched.id).toBe(organization.id);

      const roles = await getOrganizationsAccessRoles(ctxFor(member), [organization.id]);
      expect(roles.get(organization.id)).toBe('owner');
    });
  });

  test('ensureOrganizationAccess records the org an admin reached without membership', async () => {
    const admin = await insertTestUser({ is_admin: true, is_super_admin: true });
    const organization = await orgOwnedByAnotherUser();

    await expect(ensureOrganizationAccess(ctxFor(admin), organization.id)).resolves.toBe('owner');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
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
    // `/api/auto-routing/settings` call this helper with a hand-rolled
    // `{ user }`. Labelling those `surface:"trpc"`/`authVia:"session"` would
    // hide a token-authenticated admin read behind a web-console-looking event.
    const admin = await insertTestUser({ is_admin: true });
    const organization = await orgOwnedByAnotherUser();

    await expect(ensureOrganizationAccess({ user: admin }, organization.id)).resolves.toBe('owner');

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      surface: 'rest',
      kind: 'kilo_admin_elevation',
      kiloUserId: admin.id,
      route: null,
      method: null,
      reason: 'organization_access',
      target: `organization:${organization.id}`,
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
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
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
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
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

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: 'organization_fetch',
      target: `organization:${missingId}`,
    });
  });
});

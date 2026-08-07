import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  ensureOrganizationAccess,
  ensureOrganizationAccessAndFetchOrg,
  getOrganizationsAccessRoles,
} from './utils';
import {
  setAdminAccessSinkForTest,
  type AdminAccessEvent,
} from '@/lib/admin/admin-access-log';
import type { TRPCContext } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { organization_memberships, organizations, type User } from '@kilocode/db/schema';

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

    await expect(
      ensureOrganizationAccessAndFetchOrg(ctxFor(admin), missingId)
    ).rejects.toThrow(/Organization not found/);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      reason: 'organization_fetch',
      target: `organization:${missingId}`,
    });
  });
});

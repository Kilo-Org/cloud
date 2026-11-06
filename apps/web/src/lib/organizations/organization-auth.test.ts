import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { getAuthorizedOrgContext } from './organization-auth';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  organization_memberships,
  organizations,
  support_access_grant_events,
  support_access_grants,
} from '@kilocode/db/schema';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { NextResponse } from 'next/server';
import { eq, isNotNull } from 'drizzle-orm';
import type { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { failureResult } from '@kilocode/web-shared/lib/maybe-result';
import {
  setAdminAccessSinkForTest,
  type AdminAccessEvent,
} from '@kilocode/web-shared/lib/admin/admin-access-log';

function enableSupportAccess(enabled: boolean) {
  if (enabled) process.env.SUPPORT_ACCESS_ENABLED = 'true';
  else delete process.env.SUPPORT_ACCESS_ENABLED;
}

describe('getAuthorizedOrgContext', () => {
  let testOrganizationId: string;

  beforeEach(async () => {
    const orgResult = await db
      .insert(organizations)
      .values({
        name: 'Test Organization',
        auto_top_up_enabled: true,
      })
      .returning();
    testOrganizationId = orgResult[0].id;
  });

  afterEach(async () => {
    enableSupportAccess(false);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(support_access_grant_events);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(support_access_grants);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_memberships);
    // Self-referential organization FKs require unlinking children before deleting all orgs.
    await db
      .update(organizations)
      .set({ parent_organization_id: null })
      .where(isNotNull(organizations.parent_organization_id));
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organizations);
  });

  describe('admin users', () => {
    test('should allow admin users without checking organization membership', async () => {
      const adminUser = await insertTestUser({ is_admin: true });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: adminUser,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext(testOrganizationId, undefined, {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user).toEqual({ ...adminUser, role: 'owner' });
        expect(result.data.organization.id).toBe(testOrganizationId);
      }
    });

    test('labels the admin elevation with the surface the caller reports', async () => {
      const adminUser = await insertTestUser({ is_admin: true });
      const events: AdminAccessEvent[] = [];
      setAdminAccessSinkForTest(event => events.push(event));

      try {
        const result = await getAuthorizedOrgContext(testOrganizationId, undefined, {
          getUserFromAuthOverride: async () => ({ user: adminUser, authFailedResponse: null }),
          surface: 'server-component',
        });
        expect(result.success).toBe(true);
      } finally {
        setAdminAccessSinkForTest(null);
      }

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'kilo_admin_elevation',
        reason: 'organization_access_rest',
        surface: 'server-component',
        target: `organization:${testOrganizationId}`,
      });
    });

    test('records the elevation and still succeeds when the membership query throws', async () => {
      const adminUser = await insertTestUser({ is_admin: true });
      const events: AdminAccessEvent[] = [];
      setAdminAccessSinkForTest(event => events.push(event));

      const originalSelect = db.select.bind(db);
      const selectSpy = jest.spyOn(db, 'select').mockImplementation((...args) => {
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

      let result: Awaited<ReturnType<typeof getAuthorizedOrgContext>>;
      try {
        result = await getAuthorizedOrgContext(testOrganizationId, undefined, {
          getUserFromAuthOverride: async () => ({ user: adminUser, authFailedResponse: null }),
        });
      } finally {
        selectSpy.mockRestore();
        setAdminAccessSinkForTest(null);
      }

      expect(result.success).toBe(true);
      expect(events.find(event => event.kind === 'kilo_admin_elevation')).toMatchObject({
        kind: 'kilo_admin_elevation',
        membershipRole: null,
        wouldPassWithoutAdmin: null,
      });
    });

    test('records the elevation before returning 404 for a missing organization', async () => {
      const adminUser = await insertTestUser({ is_admin: true });
      const events: AdminAccessEvent[] = [];
      setAdminAccessSinkForTest(event => events.push(event));
      try {
        const result = await getAuthorizedOrgContext(crypto.randomUUID(), undefined, {
          getUserFromAuthOverride: async () => ({ user: adminUser, authFailedResponse: null }),
        });
        expect(result.success).toBe(false);
        if (!result.success) expect(result.nextResponse.status).toBe(404);
      } finally {
        setAdminAccessSinkForTest(null);
      }
      expect(events.find(event => event.kind === 'kilo_admin_elevation')).toMatchObject({
        reason: 'organization_access_rest',
      });
    });

    test('should allow admin users even if they are not in organization_memberships', async () => {
      const adminUser = await insertTestUser({ is_admin: true });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: adminUser,
        authFailedResponse: null,
      });

      const memberships = await db
        .select()
        .from(organization_memberships)
        .where(eq(organization_memberships.kilo_user_id, adminUser.id));
      expect(memberships).toHaveLength(0);

      const result = await getAuthorizedOrgContext(testOrganizationId, undefined, {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user).toEqual({ ...adminUser, role: 'owner' });
        expect(result.data.organization.id).toBe(testOrganizationId);
      }
    });

    test('should allow admin users with specific role requirements', async () => {
      const adminUser = await insertTestUser({ is_admin: true });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: adminUser,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext(testOrganizationId, ['owner'], {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user).toEqual({ ...adminUser, role: 'owner' });
        expect(result.data.organization.id).toBe(testOrganizationId);
      }
    });
  });

  describe('non-admin users', () => {
    test('should allow non-admin users with valid organization membership', async () => {
      const regularUser = await insertTestUser({ is_admin: false });

      await db.insert(organization_memberships).values({
        organization_id: testOrganizationId,
        kilo_user_id: regularUser.id,
        role: 'member',
        invited_by: 'test-admin',
      });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: regularUser,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext(testOrganizationId, undefined, {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user).toEqual({ ...regularUser, role: 'member' });
        expect(result.data.organization.id).toBe(testOrganizationId);
      }
    });

    test('should deny non-admin users without organization membership', async () => {
      const regularUser = await insertTestUser({ is_admin: false });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: regularUser,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext(testOrganizationId, undefined, {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.nextResponse.status).toBe(404);
        const responseBody = await result.nextResponse.json();
        expect(responseBody.error).toBe('Organization not found');
      }
    });

    test('should allow non-admin users with correct role when roles are specified', async () => {
      const regularUser = await insertTestUser({ is_admin: false });

      await db.insert(organization_memberships).values({
        organization_id: testOrganizationId,
        kilo_user_id: regularUser.id,
        role: 'owner',
        invited_by: 'test-admin',
      });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: regularUser,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext(testOrganizationId, ['owner'], {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user).toEqual({ ...regularUser, role: 'owner' });
        expect(result.data.organization.id).toBe(testOrganizationId);
      }
    });

    test('should deny non-admin users with wrong role when roles are specified', async () => {
      const regularUser = await insertTestUser({ is_admin: false });

      await db.insert(organization_memberships).values({
        organization_id: testOrganizationId,
        kilo_user_id: regularUser.id,
        role: 'member',
        invited_by: 'test-admin',
      });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: regularUser,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext(testOrganizationId, ['owner'], {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.nextResponse.status).toBe(404);
        const responseBody = await result.nextResponse.json();
        expect(responseBody.error).toBe('Organization not found');
      }
    });

    test('should deny non-admin users with membership in different organization', async () => {
      const regularUser = await insertTestUser({ is_admin: false });

      const otherOrgResult = await db
        .insert(organizations)
        .values({
          name: 'Other Organization',
          auto_top_up_enabled: true,
        })
        .returning();
      const otherOrganizationId = otherOrgResult[0].id;

      await db.insert(organization_memberships).values({
        organization_id: otherOrganizationId,
        kilo_user_id: regularUser.id,
        role: 'owner',
        invited_by: 'test-admin',
      });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: regularUser,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext(testOrganizationId, undefined, {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.nextResponse.status).toBe(404);
        const responseBody = await result.nextResponse.json();
        expect(responseBody.error).toBe('Organization not found');
      }
    });

    test('should allow parent organization owners to access child organizations', async () => {
      const parentOwner = await insertTestUser({ is_admin: false });
      const [childOrganization] = await db
        .insert(organizations)
        .values({ name: 'Child Organization', parent_organization_id: testOrganizationId })
        .returning();

      await db.insert(organization_memberships).values({
        organization_id: testOrganizationId,
        kilo_user_id: parentOwner.id,
        role: 'owner',
        invited_by: 'test-admin',
      });

      await db.insert(organization_memberships).values({
        organization_id: childOrganization.id,
        kilo_user_id: parentOwner.id,
        role: 'member',
        invited_by: 'test-admin',
      });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: parentOwner,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext(childOrganization.id, undefined, {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user).toEqual({ ...parentOwner, role: 'owner' });
        expect(result.data.organization.id).toBe(childOrganization.id);
      }
    });

    test('should allow parent organization billing managers to access child billing pages', async () => {
      const parentBillingManager = await insertTestUser({ is_admin: false });
      const [childOrganization] = await db
        .insert(organizations)
        .values({ name: 'Child Billing Organization', parent_organization_id: testOrganizationId })
        .returning();

      await db.insert(organization_memberships).values({
        organization_id: testOrganizationId,
        kilo_user_id: parentBillingManager.id,
        role: 'billing_manager',
        invited_by: 'test-admin',
      });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: parentBillingManager,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext(
        childOrganization.id,
        ['owner', 'billing_manager'],
        { getUserFromAuthOverride: mockGetUserFromAuth }
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user).toEqual({ ...parentBillingManager, role: 'billing_manager' });
        expect(result.data.organization.id).toBe(childOrganization.id);
      }
    });

    test('should deny parent organization members access to child organizations', async () => {
      const parentMember = await insertTestUser({ is_admin: false });
      const [childOrganization] = await db
        .insert(organizations)
        .values({ name: 'Child Member Organization', parent_organization_id: testOrganizationId })
        .returning();

      await db.insert(organization_memberships).values({
        organization_id: testOrganizationId,
        kilo_user_id: parentMember.id,
        role: 'member',
        invited_by: 'test-admin',
      });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: parentMember,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext(childOrganization.id, undefined, {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.nextResponse.status).toBe(404);
      }
    });
  });

  test('denies inherited access when the parent organization is soft-deleted', async () => {
    const parentOwner = await insertTestUser({ is_admin: false });
    const [childOrganization] = await db
      .insert(organizations)
      .values({ name: 'Child Of Deleted Parent', parent_organization_id: testOrganizationId })
      .returning();
    await db.insert(organization_memberships).values({
      organization_id: testOrganizationId,
      kilo_user_id: parentOwner.id,
      role: 'owner',
      invited_by: 'test-admin',
    });
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, testOrganizationId));

    const result = await getAuthorizedOrgContext(childOrganization.id, undefined, {
      getUserFromAuthOverride: async () => ({
        user: parentOwner,
        authFailedResponse: null,
      }),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.nextResponse.status).toBe(404);
    }
  });

  test('when on, admits an allowlisted REST read with a support grant', async () => {
    enableSupportAccess(true);
    const admin = await insertTestUser({
      is_admin: true,
    });
    const now = new Date();
    await db.insert(support_access_grants).values({
      actor_kilo_user_id: admin.id,
      organization_id: testOrganizationId,
      action_class: 'support_read',
      status: 'active',
      reason: 'investigating a customer report',
      requested_duration_seconds: 1800,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    });

    const result = await getAuthorizedOrgContext(testOrganizationId, undefined, {
      getUserFromAuthOverride: async () => ({ user: admin, authFailedResponse: null }),
      supportKey: '/api/organizations/[id]/defaults',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.user.role).toBe('member');
      expect(result.data.access.kind).toBe('support');
    }
  });

  test('when on, denies a REST read whose route is not allowlisted', async () => {
    enableSupportAccess(true);
    const admin = await insertTestUser({
      is_admin: true,
    });
    const now = new Date();
    await db.insert(support_access_grants).values({
      actor_kilo_user_id: admin.id,
      organization_id: testOrganizationId,
      action_class: 'support_read',
      status: 'active',
      reason: 'investigating a customer report',
      requested_duration_seconds: 1800,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
    });

    const result = await getAuthorizedOrgContext(testOrganizationId, undefined, {
      getUserFromAuthOverride: async () => ({ user: admin, authFailedResponse: null }),
      supportKey: '/api/organizations/[id]/user-tokens',
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.nextResponse.status).toBe(403);
      await expect(result.nextResponse.json()).resolves.toMatchObject({
        code: 'support_access_not_allowlisted',
      });
    }
  });

  test('when on, a grant lookup failure returns a retryable 503', async () => {
    enableSupportAccess(true);
    const admin = await insertTestUser({ is_admin: true });
    const originalSelect = db.select.bind(db);
    const selectSpy = jest.spyOn(db, 'select').mockImplementation((...args) => {
      const builder = originalSelect(...args);
      return new Proxy(builder, {
        get(target, property, receiver) {
          if (property === 'from') {
            return (table: Parameters<typeof target.from>[0]) => {
              if (table === support_access_grants) {
                throw new Error('grant lookup failed');
              }
              return target.from(table);
            };
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
    });
    try {
      const result = await getAuthorizedOrgContext(testOrganizationId, undefined, {
        getUserFromAuthOverride: async () => ({ user: admin, authFailedResponse: null }),
        supportKey: '/api/organizations/[id]/defaults',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.nextResponse.status).toBe(503);
        await expect(result.nextResponse.json()).resolves.toMatchObject({
          code: 'support_grant_lookup_failed',
        });
      }
    } finally {
      selectSpy.mockRestore();
    }
  });

  describe('authentication failures', () => {
    test('should return auth failure when getUserFromAuth fails', async () => {
      const authFailedResponse = NextResponse.json(failureResult('Unauthorized'), { status: 401 });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: null,
        authFailedResponse,
      });

      const result = await getAuthorizedOrgContext(testOrganizationId, undefined, {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.nextResponse).toBe(authFailedResponse);
      }
    });
  });

  describe('invalid organization ID', () => {
    test('should return error for invalid UUID format', async () => {
      const regularUser = await insertTestUser({ is_admin: false });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: regularUser,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext('invalid-uuid', undefined, {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.nextResponse.status).toBe(400);
      }
    });

    test('should return error for empty organization ID', async () => {
      const regularUser = await insertTestUser({ is_admin: false });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: regularUser,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext('', undefined, {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.nextResponse.status).toBe(400);
      }
    });
  });

  describe('role combinations', () => {
    test('should work with single role requirement', async () => {
      const regularUser = await insertTestUser({ is_admin: false });

      await db.insert(organization_memberships).values({
        organization_id: testOrganizationId,
        kilo_user_id: regularUser.id,
        role: 'member',
        invited_by: 'test-admin',
      });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: regularUser,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext(testOrganizationId, ['member'], {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user).toEqual({ ...regularUser, role: 'member' });
        expect(result.data.organization.id).toBe(testOrganizationId);
      }
    });

    test('should work with multiple role requirements', async () => {
      const regularUser = await insertTestUser({ is_admin: false });

      await db.insert(organization_memberships).values({
        organization_id: testOrganizationId,
        kilo_user_id: regularUser.id,
        role: 'owner',
        invited_by: 'test-admin',
      });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: regularUser,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext(testOrganizationId, ['owner', 'member'], {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user).toEqual({ ...regularUser, role: 'owner' });
        expect(result.data.organization.id).toBe(testOrganizationId);
      }
    });

    test('should work with empty roles array (any role allowed)', async () => {
      const regularUser = await insertTestUser({ is_admin: false });

      await db.insert(organization_memberships).values({
        organization_id: testOrganizationId,
        kilo_user_id: regularUser.id,
        role: 'member',
        invited_by: 'test-admin',
      });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: regularUser,
        authFailedResponse: null,
      });

      const result = await getAuthorizedOrgContext(testOrganizationId, [], {
        getUserFromAuthOverride: mockGetUserFromAuth,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user).toEqual({ ...regularUser, role: 'member' });
        expect(result.data.organization.id).toBe(testOrganizationId);
      }
    });
  });
});

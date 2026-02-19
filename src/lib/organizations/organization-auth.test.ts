import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { getAuthorizedOrgContext } from './organization-auth';
import { db } from '@/lib/drizzle';
import { organization_memberships, organizations } from '@/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import type { getUserFromAuth } from '@/lib/user.server';
import { failureResult } from '@/lib/maybe-result';

describe('getAuthorizedOrgContext', () => {
  let testOrganizationId: string;

  beforeEach(async () => {
    // Create a test organization
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
    // Clean up organization_memberships table
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(organization_memberships);
    // Clean up organizations table
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

      const result = await getAuthorizedOrgContext(
        testOrganizationId,
        undefined,
        mockGetUserFromAuth
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user).toEqual({ ...adminUser, role: 'owner' });
        expect(result.data.organization.id).toBe(testOrganizationId);
      }
    });

    test('should allow admin users even if they are not in organization_memberships', async () => {
      const adminUser = await insertTestUser({ is_admin: true });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: adminUser,
        authFailedResponse: null,
      });

      // Explicitly verify no membership exists
      const memberships = await db
        .select()
        .from(organization_memberships)
        .where(eq(organization_memberships.kilo_user_id, adminUser.id));
      expect(memberships).toHaveLength(0);

      const result = await getAuthorizedOrgContext(
        testOrganizationId,
        undefined,
        mockGetUserFromAuth
      );

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

      const result = await getAuthorizedOrgContext(
        testOrganizationId,
        ['owner'],
        mockGetUserFromAuth
      );

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

      // Insert membership
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

      const result = await getAuthorizedOrgContext(
        testOrganizationId,
        undefined,
        mockGetUserFromAuth
      );

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

      const result = await getAuthorizedOrgContext(
        testOrganizationId,
        undefined,
        mockGetUserFromAuth
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.nextResponse.status).toBe(404);
        const responseBody = await result.nextResponse.json();
        expect(responseBody.error).toBe('Organization not found');
      }
    });

    test('should allow non-admin users with correct role when roles are specified', async () => {
      const regularUser = await insertTestUser({ is_admin: false });

      // Insert membership with 'owner' role
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

      const result = await getAuthorizedOrgContext(
        testOrganizationId,
        ['owner'],
        mockGetUserFromAuth
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user).toEqual({ ...regularUser, role: 'owner' });
        expect(result.data.organization.id).toBe(testOrganizationId);
      }
    });

    test('should deny non-admin users with wrong role when roles are specified', async () => {
      const regularUser = await insertTestUser({ is_admin: false });

      // Insert membership with 'member' role
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

      const result = await getAuthorizedOrgContext(
        testOrganizationId,
        ['owner'],
        mockGetUserFromAuth
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.nextResponse.status).toBe(404);
        const responseBody = await result.nextResponse.json();
        expect(responseBody.error).toBe('Organization not found');
      }
    });

    test('should deny non-admin users with membership in different organization', async () => {
      const regularUser = await insertTestUser({ is_admin: false });

      // Create another organization
      const otherOrgResult = await db
        .insert(organizations)
        .values({
          name: 'Other Organization',
          auto_top_up_enabled: true,
        })
        .returning();
      const otherOrganizationId = otherOrgResult[0].id;

      // Insert membership for the OTHER organization
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

      const result = await getAuthorizedOrgContext(
        testOrganizationId,
        undefined,
        mockGetUserFromAuth
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.nextResponse.status).toBe(404);
        const responseBody = await result.nextResponse.json();
        expect(responseBody.error).toBe('Organization not found');
      }
    });
  });

  describe('authentication failures', () => {
    test('should return auth failure when getUserFromAuth fails', async () => {
      const authFailedResponse = NextResponse.json(failureResult('Unauthorized'), { status: 401 });

      const mockGetUserFromAuth: typeof getUserFromAuth = async () => ({
        user: null,
        authFailedResponse,
      });

      const result = await getAuthorizedOrgContext(
        testOrganizationId,
        undefined,
        mockGetUserFromAuth
      );

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

      const result = await getAuthorizedOrgContext('invalid-uuid', undefined, mockGetUserFromAuth);

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

      const result = await getAuthorizedOrgContext('', undefined, mockGetUserFromAuth);

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

      const result = await getAuthorizedOrgContext(
        testOrganizationId,
        ['member'],
        mockGetUserFromAuth
      );

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

      const result = await getAuthorizedOrgContext(
        testOrganizationId,
        ['owner', 'member'],
        mockGetUserFromAuth
      );

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

      const result = await getAuthorizedOrgContext(testOrganizationId, [], mockGetUserFromAuth);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.user).toEqual({ ...regularUser, role: 'member' });
        expect(result.data.organization.id).toBe(testOrganizationId);
      }
    });
  });
});

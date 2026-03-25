import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
import type { User, Organization } from '@kilocode/db/schema';

// Mock the email service to prevent actual API calls during tests
jest.mock('@/lib/email', () => ({
  sendOrganizationInviteEmail: jest.fn().mockResolvedValue({ sent: true }),
  subjects: { orgInvitation: 'Kilo: Teams Invitation' },
  renderTemplate: jest.fn().mockReturnValue('<html></html>'),
  creditsVars: jest.fn().mockReturnValue({}),
  RawHtml: class RawHtml {
    constructor(public readonly html: string) {}
  },
}));

// Test users and organization will be created dynamically
let regularUser: User;
let adminUser: User;
let memberUser: User;
let nonMemberUser: User;
let testOrganization: Organization;

describe('organizations members trpc router', () => {
  beforeAll(async () => {
    // Create test users using the helper function
    regularUser = await insertTestUser({
      google_user_email: 'regular-members@example.com',
      google_user_name: 'Regular Members User',
      is_admin: false,
    });

    adminUser = await insertTestUser({
      google_user_email: 'admin-members@admin.example.com',
      google_user_name: 'Admin Members User',
      is_admin: true,
    });

    memberUser = await insertTestUser({
      google_user_email: 'member-members@example.com',
      google_user_name: 'Member Members User',
      is_admin: false,
    });

    nonMemberUser = await insertTestUser({
      google_user_email: 'non-member-members@example.com',
      google_user_name: 'Non Member Members User',
      is_admin: false,
    });

    // Create test organization using the CRUD method
    testOrganization = await createOrganization('Test Members Organization', regularUser.id);

    // Add member user to organization using CRUD method
    await addUserToOrganization(testOrganization.id, memberUser.id, 'member');
  });

  describe('update procedure', () => {
    it('should update member role for organization owner', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.organizations.members.update({
        organizationId: testOrganization.id,
        memberId: memberUser.id,
        role: 'owner',
      });

      expect(result).toEqual({
        success: true,
        updated: 'role and limit',
      });
    });

    it('should update daily usage limit for organization owner', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.organizations.members.update({
        organizationId: testOrganization.id,
        memberId: memberUser.id,
        dailyUsageLimitUsd: 50.0,
      });

      expect(result).toEqual({
        success: true,
        updated: 'limit',
      });
    });

    it('should allow system admin users to update members', async () => {
      const caller = await createCallerForUser(adminUser.id);

      const result = await caller.organizations.members.update({
        organizationId: testOrganization.id,
        memberId: memberUser.id,
        role: 'member',
        dailyUsageLimitUsd: 25.0,
      });

      expect(result).toEqual({
        success: true,
        updated: 'role and limit',
      });
    });

    it('should throw FORBIDDEN error when user tries to change their own role', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.organizations.members.update({
          organizationId: testOrganization.id,
          memberId: regularUser.id,
          role: 'member',
        })
      ).rejects.toThrow('You cannot change your own role');
    });

    it('should throw FORBIDDEN error when non-owner tries to assign owner role', async () => {
      // Create a test user to be the target of the role update
      const targetUser = await insertTestUser({
        google_user_email: 'target-role-update@example.com',
        google_user_name: 'Target Role Update User',
        is_admin: false,
      });
      await addUserToOrganization(testOrganization.id, targetUser.id, 'member');

      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.members.update({
          organizationId: testOrganization.id,
          memberId: targetUser.id,
          role: 'owner',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should throw UNAUTHORIZED error for non-member users', async () => {
      const caller = await createCallerForUser(nonMemberUser.id);

      await expect(
        caller.organizations.members.update({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
          role: 'owner',
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should validate input schema', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Test invalid UUID
      await expect(
        caller.organizations.members.update({
          organizationId: 'invalid-uuid',
          memberId: memberUser.id,
          role: 'owner',
        })
      ).rejects.toThrow();

      // Test invalid daily usage limit (too high)
      await expect(
        caller.organizations.members.update({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
          dailyUsageLimitUsd: 3000, // Over MAX_DAILY_LIMIT_USD
        })
      ).rejects.toThrow();

      // Test invalid daily usage limit (negative)
      await expect(
        caller.organizations.members.update({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
          dailyUsageLimitUsd: -10,
        })
      ).rejects.toThrow();
    });
  });

  describe('remove procedure', () => {
    let testMemberUser: User;

    beforeAll(async () => {
      // Create dedicated test users for remove tests to avoid conflicts
      testMemberUser = await insertTestUser({
        google_user_email: 'test-member-remove@example.com',
        google_user_name: 'Test Member Remove User',
        is_admin: false,
      });

      // Add them to the organization
      await addUserToOrganization(testOrganization.id, testMemberUser.id, 'member');
    });

    it('should remove member for organization owner', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.organizations.members.remove({
        organizationId: testOrganization.id,
        memberId: testMemberUser.id,
      });

      expect(result).toEqual({
        success: true,
        updated: testMemberUser.id,
      });

      // Add the user back for other tests
      await addUserToOrganization(testOrganization.id, testMemberUser.id, 'member');
    });

    it('should allow system admin users to remove any member', async () => {
      const caller = await createCallerForUser(adminUser.id);

      const result = await caller.organizations.members.remove({
        organizationId: testOrganization.id,
        memberId: testMemberUser.id,
      });

      expect(result).toEqual({
        success: true,
        updated: testMemberUser.id,
      });

      // Add the user back for other tests
      await addUserToOrganization(testOrganization.id, testMemberUser.id, 'member');
    });

    it('should throw UNAUTHORIZED error when regular member tries to remove themselves', async () => {
      // Create a fresh user for this test to avoid conflicts
      const freshMemberUser = await insertTestUser({
        google_user_email: 'fresh-member-remove@example.com',
        google_user_name: 'Fresh Member Remove User',
        is_admin: false,
      });

      // Add them to the organization as a regular member (not admin/owner)
      await addUserToOrganization(testOrganization.id, freshMemberUser.id, 'member');

      const caller = await createCallerForUser(freshMemberUser.id);

      // Regular members don't have permission to remove members (including themselves)
      // The access check happens first, so they get UNAUTHORIZED before the self-removal check
      await expect(
        caller.organizations.members.remove({
          organizationId: testOrganization.id,
          memberId: freshMemberUser.id,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should throw NOT_FOUND error for non-existent member', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.organizations.members.remove({
          organizationId: testOrganization.id,
          memberId: nonMemberUser.id,
        })
      ).rejects.toThrow('User is not a member of this organization');
    });

    it('should throw UNAUTHORIZED error for non-member users', async () => {
      const caller = await createCallerForUser(nonMemberUser.id);

      await expect(
        caller.organizations.members.remove({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should validate input schema', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Test invalid UUID
      await expect(
        caller.organizations.members.remove({
          organizationId: 'invalid-uuid',
          memberId: memberUser.id,
        })
      ).rejects.toThrow();
    });
  });

  describe('invite procedure', () => {
    it('should invite member for organization owner', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email: 'new-member@example.com',
        role: 'member',
      });

      expect(result).toHaveProperty('acceptInviteUrl');
      expect(result.acceptInviteUrl).toMatch(/^https?:\/\/.+\/users\/accept-invite\/.+$/);
    });

    it('should allow owner to invite owner', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email: 'new-owner@example.com',
        role: 'owner',
      });

      expect(result).toHaveProperty('acceptInviteUrl');
      expect(result.acceptInviteUrl).toMatch(/^https?:\/\/.+\/users\/accept-invite\/.+$/);
    });

    it('should allow system admin to invite any role', async () => {
      const caller = await createCallerForUser(adminUser.id);

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email: 'system-admin-invite@example.com',
        role: 'owner',
      });

      expect(result).toHaveProperty('acceptInviteUrl');
      expect(result.acceptInviteUrl).toMatch(/^https?:\/\/.+\/users\/accept-invite\/.+$/);
    });

    it('should throw UNAUTHORIZED error for non-member users', async () => {
      const caller = await createCallerForUser(nonMemberUser.id);

      await expect(
        caller.organizations.members.invite({
          organizationId: testOrganization.id,
          email: 'non-member-invite@example.com',
          role: 'member',
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should throw NOT_FOUND error for non-existent organization', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const nonExistentOrgId = '550e8400-e29b-41d4-a716-446655440003';

      await expect(
        caller.organizations.members.invite({
          organizationId: nonExistentOrgId,
          email: 'test@example.com',
          role: 'member',
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should validate input schema', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Test invalid UUID
      await expect(
        caller.organizations.members.invite({
          organizationId: 'invalid-uuid',
          email: 'test@example.com',
          role: 'member',
        })
      ).rejects.toThrow();

      // Test invalid email
      await expect(
        caller.organizations.members.invite({
          organizationId: testOrganization.id,
          email: 'invalid-email',
          role: 'member',
        })
      ).rejects.toThrow();

      // Test invalid role
      await expect(
        caller.organizations.members.invite({
          organizationId: testOrganization.id,
          email: 'test@example.com',
          // @ts-expect-error Testing invalid role
          role: 'invalid-role',
        })
      ).rejects.toThrow();
    });
  });

  describe('deleteInvite procedure', () => {
    let testInviteId: string;

    beforeAll(async () => {
      // Create a test invitation to delete
      const caller = await createCallerForUser(regularUser.id);
      await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email: 'delete-test@example.com',
        role: 'member',
      });

      // Get the invitation ID from the database
      const { db } = await import('@/lib/drizzle');
      const { organization_invitations } = await import('@kilocode/db/schema');
      const { eq, and } = await import('drizzle-orm');

      const invitation = await db
        .select()
        .from(organization_invitations)
        .where(
          and(
            eq(organization_invitations.organization_id, testOrganization.id),
            eq(organization_invitations.email, 'delete-test@example.com')
          )
        )
        .limit(1);

      testInviteId = invitation[0].id;
    });

    it('should delete invitation for organization owner', async () => {
      const caller = await createCallerForUser(regularUser.id);

      const result = await caller.organizations.members.deleteInvite({
        organizationId: testOrganization.id,
        inviteId: testInviteId,
      });

      expect(result).toEqual({
        success: true,
        updated: testInviteId,
      });
    });

    it('should allow system admin to delete any invitation', async () => {
      // Create another invitation to delete
      const ownerCaller = await createCallerForUser(regularUser.id);
      await ownerCaller.organizations.members.invite({
        organizationId: testOrganization.id,
        email: 'system-admin-delete@example.com',
        role: 'member',
      });

      // Get the invitation ID from the database
      const { db } = await import('@/lib/drizzle');
      const { organization_invitations } = await import('@kilocode/db/schema');
      const { eq, and } = await import('drizzle-orm');

      const invitation = await db
        .select()
        .from(organization_invitations)
        .where(
          and(
            eq(organization_invitations.organization_id, testOrganization.id),
            eq(organization_invitations.email, 'system-admin-delete@example.com')
          )
        )
        .limit(1);

      const inviteId = invitation[0].id;

      const caller = await createCallerForUser(adminUser.id);

      const result = await caller.organizations.members.deleteInvite({
        organizationId: testOrganization.id,
        inviteId: inviteId,
      });

      expect(result).toEqual({
        success: true,
        updated: inviteId,
      });
    });

    it('should allow admin to delete member invitation', async () => {
      // Create a test admin user for this test
      const testAdminUser = await insertTestUser({
        google_user_email: 'test-admin-delete@example.com',
        google_user_name: 'Test Admin Delete User',
        is_admin: false,
      });
      await addUserToOrganization(testOrganization.id, testAdminUser.id, 'owner');

      // Create a member invitation
      const ownerCaller = await createCallerForUser(regularUser.id);
      await ownerCaller.organizations.members.invite({
        organizationId: testOrganization.id,
        email: 'admin-delete-member@example.com',
        role: 'member',
      });

      // Get the invitation ID from the database
      const { db } = await import('@/lib/drizzle');
      const { organization_invitations } = await import('@kilocode/db/schema');
      const { eq, and } = await import('drizzle-orm');

      const invitation = await db
        .select()
        .from(organization_invitations)
        .where(
          and(
            eq(organization_invitations.organization_id, testOrganization.id),
            eq(organization_invitations.email, 'admin-delete-member@example.com')
          )
        )
        .limit(1);

      const inviteId = invitation[0].id;

      const caller = await createCallerForUser(testAdminUser.id);

      const result = await caller.organizations.members.deleteInvite({
        organizationId: testOrganization.id,
        inviteId: inviteId,
      });

      expect(result).toEqual({
        success: true,
        updated: inviteId,
      });
    });

    it('should throw NOT_FOUND error for non-existent invitation', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const nonExistentInviteId = '550e8400-e29b-41d4-a716-446655440004';

      await expect(
        caller.organizations.members.deleteInvite({
          organizationId: testOrganization.id,
          inviteId: nonExistentInviteId,
        })
      ).rejects.toThrow('Invitation not found');
    });

    it('should throw UNAUTHORIZED error for non-member users', async () => {
      const caller = await createCallerForUser(nonMemberUser.id);

      await expect(
        caller.organizations.members.deleteInvite({
          organizationId: testOrganization.id,
          inviteId: 'some-invite-id',
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should validate input schema', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Test invalid UUID
      await expect(
        caller.organizations.members.deleteInvite({
          organizationId: 'invalid-uuid',
          inviteId: 'some-invite-id',
        })
      ).rejects.toThrow();
    });
  });
});

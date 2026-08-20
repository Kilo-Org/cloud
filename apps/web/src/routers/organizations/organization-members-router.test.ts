import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  createOrganization,
  addUserToOrganization,
  updateUserRoleInOrganization,
} from '@/lib/organizations/organizations';
import {
  organization_audit_logs,
  organization_memberships,
  organization_invitations,
  organizations,
  external_side_effect_outbox,
  type User,
  type Organization,
} from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { and, eq, sql } from 'drizzle-orm';
import { invalidateOrganizationSessionAccess } from '@/lib/session-ingest-client';
import { sendOrganizationInviteEmail } from '@/lib/email';
import { dispatchQueuedInviteEmails } from '@/lib/organizations/dispatch-invite-email-outbox';
import { resetInviteEmailForResend } from '@kilocode/db/external-side-effect-outbox';

jest.mock('@/lib/session-ingest-client', () => ({
  invalidateOrganizationSessionAccess: jest.fn().mockResolvedValue(undefined),
}));

// Mock `updateUserRoleInOrganization` so the failed-role-update test can drive a
// failure inside the transaction while every other test keeps the real
// implementation. SWC makes ESM exports non-configurable, so `jest.spyOn` on the
// named export fails; replace it on the module instead.
jest.mock('@/lib/organizations/organizations', () => {
  const actual: Record<string, unknown> = jest.requireActual('@/lib/organizations/organizations');
  return {
    ...actual,
    updateUserRoleInOrganization: jest.fn(
      actual.updateUserRoleInOrganization as typeof updateUserRoleInOrganization
    ),
  };
});

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
let billingManagerUser: User;
let nonMemberUser: User;
// Holds the `admin` organization role (distinct from `adminUser`, who is Kilo staff).
let orgAdminUser: User;
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

    billingManagerUser = await insertTestUser({
      google_user_email: 'billing-manager-members@example.com',
      google_user_name: 'Billing Manager Members User',
      is_admin: false,
    });

    nonMemberUser = await insertTestUser({
      google_user_email: 'non-member-members@example.com',
      google_user_name: 'Non Member Members User',
      is_admin: false,
    });

    orgAdminUser = await insertTestUser({
      google_user_email: 'org-admin-members@example.com',
      google_user_name: 'Org Admin Members User',
      is_admin: false,
    });

    // Create test organization using the CRUD method
    testOrganization = await createOrganization('Test Members Organization', regularUser.id);

    // Add member user to organization using CRUD method
    await addUserToOrganization(testOrganization.id, memberUser.id, 'member');
    await addUserToOrganization(testOrganization.id, billingManagerUser.id, 'billing_manager');
    await addUserToOrganization(testOrganization.id, orgAdminUser.id, 'admin');
  });

  describe('listPublic procedure', () => {
    it('returns members without private invite fields', async () => {
      const ownerCaller = await createCallerForUser(regularUser.id);
      const memberCaller = await createCallerForUser(memberUser.id);
      const invitedEmail = `${crypto.randomUUID()}@public-list-invite.example.com`;

      await ownerCaller.organizations.members.invite({
        organizationId: testOrganization.id,
        email: invitedEmail,
        role: 'member',
      });

      const result = await memberCaller.organizations.members.listPublic({
        organizationId: testOrganization.id,
      });
      const activeMember = result.find(
        member => member.status === 'active' && member.id === regularUser.id
      );
      const invitedMember = result.find(member => member.status === 'invited');

      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: regularUser.id,
            name: 'Regular Members User',
            email: 'regular-members@example.com',
            role: 'owner',
            status: 'active',
          }),
          expect.objectContaining({
            email: invitedEmail,
            role: 'member',
            status: 'invited',
          }),
        ])
      );
      expect(invitedMember).toBeDefined();
      expect(activeMember).toBeDefined();
      expect(activeMember).not.toHaveProperty('dailyUsageLimitUsd');
      expect(activeMember).not.toHaveProperty('currentDailyUsageUsd');
      expect(invitedMember).not.toHaveProperty('inviteToken');
      expect(invitedMember).not.toHaveProperty('inviteId');
      expect(invitedMember).not.toHaveProperty('inviteUrl');
      expect(invitedMember).not.toHaveProperty('dailyUsageLimitUsd');
      expect(invitedMember).not.toHaveProperty('currentDailyUsageUsd');
    });
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

    it('writes a change_role audit row naming the actor and both roles', async () => {
      const targetUser = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@role-change-audit.example.com`,
        google_user_name: 'Role Change Audit Target',
        is_admin: false,
      });
      await addUserToOrganization(testOrganization.id, targetUser.id, 'member');
      const caller = await createCallerForUser(regularUser.id);

      await caller.organizations.members.update({
        organizationId: testOrganization.id,
        memberId: targetUser.id,
        role: 'admin',
      });

      const auditRows = await db
        .select()
        .from(organization_audit_logs)
        .where(
          and(
            eq(organization_audit_logs.organization_id, testOrganization.id),
            eq(organization_audit_logs.action, 'organization.member.change_role'),
            eq(
              organization_audit_logs.message,
              `Changed role for user ${targetUser.google_user_email} from member to admin`
            )
          )
        );
      expect(auditRows).toEqual([
        expect.objectContaining({
          actor_id: regularUser.id,
          actor_email: regularUser.google_user_email,
          actor_name: regularUser.google_user_name,
        }),
      ]);
    });

    it('leaves zero audit rows when a role update fails', async () => {
      const targetUser = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@failed-role-update.example.com`,
        google_user_name: 'Failed Role Update Target',
        is_admin: false,
      });
      // The user is a member, so the pre-check passes and the mutation enters the
      // role-update transaction. The mocked update then fails inside it, so the
      // audit row written in the same transaction must roll back.
      await addUserToOrganization(testOrganization.id, targetUser.id, 'member');

      const caller = await createCallerForUser(regularUser.id);

      jest
        .mocked(updateUserRoleInOrganization)
        .mockResolvedValueOnce({ success: false, updated: 'none' });

      await expect(
        caller.organizations.members.update({
          organizationId: testOrganization.id,
          memberId: targetUser.id,
          role: 'admin',
        })
      ).rejects.toThrow('Failed to update user role');

      const auditRows = await db
        .select()
        .from(organization_audit_logs)
        .where(
          and(
            eq(organization_audit_logs.organization_id, testOrganization.id),
            eq(organization_audit_logs.action, 'organization.member.change_role'),
            eq(organization_audit_logs.actor_id, regularUser.id)
          )
        );

      const rowsForTarget = auditRows.filter(row =>
        row.message.includes(targetUser.google_user_email)
      );
      expect(rowsForTarget).toHaveLength(0);
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

    it('lets an organization admin update a member role, matching owner authority', async () => {
      const targetUser = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@org-admin-update.example.com`,
        google_user_name: 'Org Admin Update Target',
        is_admin: false,
      });
      await addUserToOrganization(testOrganization.id, targetUser.id, 'member');

      const caller = await createCallerForUser(orgAdminUser.id);

      const result = await caller.organizations.members.update({
        organizationId: testOrganization.id,
        memberId: targetUser.id,
        role: 'billing_manager',
      });

      expect(result).toEqual({ success: true, updated: 'role and limit' });
    });

    it('lets an organization admin grant the admin role', async () => {
      const targetUser = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@org-admin-grant-admin.example.com`,
        google_user_name: 'Org Admin Grant Admin Target',
        is_admin: false,
      });
      await addUserToOrganization(testOrganization.id, targetUser.id, 'member');

      const caller = await createCallerForUser(orgAdminUser.id);

      const result = await caller.organizations.members.update({
        organizationId: testOrganization.id,
        memberId: targetUser.id,
        role: 'admin',
      });

      expect(result).toEqual({ success: true, updated: 'role and limit' });
    });

    it('rejects an organization admin granting the owner role', async () => {
      const targetUser = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@org-admin-promote.example.com`,
        google_user_name: 'Org Admin Promote Target',
        is_admin: false,
      });
      await addUserToOrganization(testOrganization.id, targetUser.id, 'member');

      const caller = await createCallerForUser(orgAdminUser.id);

      await expect(
        caller.organizations.members.update({
          organizationId: testOrganization.id,
          memberId: targetUser.id,
          role: 'owner',
        })
      ).rejects.toThrow('Only an organization owner can manage owners');
    });

    it('rejects an organization admin changing an existing owner role', async () => {
      const targetUser = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@org-admin-demote.example.com`,
        google_user_name: 'Org Admin Demote Target',
        is_admin: false,
      });
      await addUserToOrganization(testOrganization.id, targetUser.id, 'owner');

      const caller = await createCallerForUser(orgAdminUser.id);

      await expect(
        caller.organizations.members.update({
          organizationId: testOrganization.id,
          memberId: targetUser.id,
          role: 'member',
        })
      ).rejects.toThrow('Only an organization owner can manage owners');
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

    it('should reject billing managers promoting members to owner', async () => {
      const targetUser = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@billing-manager-promote.example.com`,
        google_user_name: 'Billing Manager Promote Target',
        is_admin: false,
      });
      await addUserToOrganization(testOrganization.id, targetUser.id, 'member');

      const caller = await createCallerForUser(billingManagerUser.id);

      await expect(
        caller.organizations.members.update({
          organizationId: testOrganization.id,
          memberId: targetUser.id,
          role: 'owner',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should reject billing managers changing owner roles', async () => {
      const caller = await createCallerForUser(billingManagerUser.id);

      await expect(
        caller.organizations.members.update({
          organizationId: testOrganization.id,
          memberId: regularUser.id,
          role: 'member',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should reject billing managers updating member usage limits', async () => {
      const caller = await createCallerForUser(billingManagerUser.id);

      await expect(
        caller.organizations.members.update({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
          dailyUsageLimitUsd: 50.0,
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

  describe('setChildMemberships procedure', () => {
    async function createChildOrganization(name: string, ownerId: string): Promise<Organization> {
      const child = await createOrganization(name, ownerId);
      await db
        .update(organizations)
        .set({ parent_organization_id: testOrganization.id, require_seats: false })
        .where(eq(organizations.id, child.id));
      return child;
    }

    async function cleanupChildOrganizations(childOrganizationIds: string[]): Promise<void> {
      if (childOrganizationIds.length === 0) return;
      for (const childOrganizationId of childOrganizationIds) {
        await db
          .update(organizations)
          .set({ parent_organization_id: null })
          .where(eq(organizations.id, childOrganizationId));
        await db.delete(organizations).where(eq(organizations.id, childOrganizationId));
      }
    }

    it('allows parent owners to assign parent members to child organizations', async () => {
      const childOwner = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@child-owner.example.com`,
        google_user_name: 'Child Owner',
        is_admin: false,
      });
      const childA = await createChildOrganization('Child Members A', childOwner.id);
      const childB = await createChildOrganization('Child Members B', childOwner.id);
      const caller = await createCallerForUser(regularUser.id);

      try {
        const result = await caller.organizations.members.setChildMemberships({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
          childOrganizationIds: [childA.id, childB.id],
        });

        expect(result).toEqual({ success: true, added: [childA.id, childB.id], removed: [] });
        const rows = await db
          .select({ organizationId: organization_memberships.organization_id })
          .from(organization_memberships)
          .where(eq(organization_memberships.kilo_user_id, memberUser.id));
        expect(rows.map(row => row.organizationId)).toEqual(
          expect.arrayContaining([childA.id, childB.id])
        );
      } finally {
        await cleanupChildOrganizations([childA.id, childB.id]);
      }
    });

    it('allows parent billing managers to assign parent members to child organizations as members', async () => {
      const childOwner = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@billing-child-owner.example.com`,
        google_user_name: 'Billing Child Owner',
        is_admin: false,
      });
      const child = await createChildOrganization('Billing Child Members', childOwner.id);
      const caller = await createCallerForUser(billingManagerUser.id);

      try {
        const result = await caller.organizations.members.setChildMemberships({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
          childOrganizationIds: [child.id],
        });

        expect(result).toEqual({ success: true, added: [child.id], removed: [] });
      } finally {
        await cleanupChildOrganizations([child.id]);
      }
    });

    it('rejects parent members assigning child memberships', async () => {
      const childOwner = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@member-child-owner.example.com`,
        google_user_name: 'Member Child Owner',
        is_admin: false,
      });
      const child = await createChildOrganization('Member Child Members', childOwner.id);
      const caller = await createCallerForUser(memberUser.id);

      try {
        await expect(
          caller.organizations.members.setChildMemberships({
            organizationId: testOrganization.id,
            memberId: memberUser.id,
            childOrganizationIds: [child.id],
          })
        ).rejects.toThrow(
          'You do not have the required organizational role to access this feature'
        );
      } finally {
        await cleanupChildOrganizations([child.id]);
      }
    });

    it('rejects assigning users who are not parent organization members', async () => {
      const childOwner = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@non-parent-child-owner.example.com`,
        google_user_name: 'Non Parent Child Owner',
        is_admin: false,
      });
      const child = await createChildOrganization('Non Parent Child Members', childOwner.id);
      const caller = await createCallerForUser(regularUser.id);

      try {
        await expect(
          caller.organizations.members.setChildMemberships({
            organizationId: testOrganization.id,
            memberId: nonMemberUser.id,
            childOrganizationIds: [child.id],
          })
        ).rejects.toThrow('User is not a member of the parent organization');
      } finally {
        await cleanupChildOrganizations([child.id]);
      }
    });

    it('rejects assigning members to organizations that are not direct children', async () => {
      const unrelatedOwner = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@unrelated-child-owner.example.com`,
        google_user_name: 'Unrelated Child Owner',
        is_admin: false,
      });
      const unrelatedOrganization = await createOrganization(
        'Unrelated Members Org',
        unrelatedOwner.id
      );
      const caller = await createCallerForUser(regularUser.id);

      try {
        await expect(
          caller.organizations.members.setChildMemberships({
            organizationId: testOrganization.id,
            memberId: memberUser.id,
            childOrganizationIds: [unrelatedOrganization.id],
          })
        ).rejects.toThrow('Selected organizations must be direct child organizations');
      } finally {
        await db.delete(organizations).where(eq(organizations.id, unrelatedOrganization.id));
      }
    });

    it('removes unselected child organization memberships regardless of role', async () => {
      const childOwner = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@elevated-child-owner.example.com`,
        google_user_name: 'Elevated Child Owner',
        is_admin: false,
      });
      const child = await createChildOrganization('Elevated Child Members', childOwner.id);
      await addUserToOrganization(child.id, memberUser.id, 'owner');
      jest.mocked(invalidateOrganizationSessionAccess).mockClear();
      const caller = await createCallerForUser(regularUser.id);

      try {
        const result = await caller.organizations.members.setChildMemberships({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
          childOrganizationIds: [],
        });

        expect(result).toEqual({ success: true, added: [], removed: [child.id] });
        expect(invalidateOrganizationSessionAccess).toHaveBeenCalledWith(memberUser.id, child.id);
        const [membership] = await db
          .select({ role: organization_memberships.role })
          .from(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, child.id),
              eq(organization_memberships.kilo_user_id, memberUser.id)
            )
          );
        expect(membership).toBeUndefined();
      } finally {
        await cleanupChildOrganizations([child.id]);
      }
    });
  });

  describe('remove procedure', () => {
    let testMemberUser: User;

    beforeEach(() => {
      jest.mocked(invalidateOrganizationSessionAccess).mockClear();
    });

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
      expect(invalidateOrganizationSessionAccess).toHaveBeenCalledWith(
        testMemberUser.id,
        testOrganization.id
      );

      // Add the user back for other tests
      await addUserToOrganization(testOrganization.id, testMemberUser.id, 'member');
    });

    it('should complete removal when session access invalidation fails', async () => {
      const user = await insertTestUser({
        google_user_email: 'best-effort-invalidation@example.com',
        google_user_name: 'Best Effort Invalidation User',
        is_admin: false,
      });
      await addUserToOrganization(testOrganization.id, user.id, 'member');
      jest
        .mocked(invalidateOrganizationSessionAccess)
        .mockRejectedValueOnce(new Error('invalidation unavailable'));
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.organizations.members.remove({
          organizationId: testOrganization.id,
          memberId: user.id,
        })
      ).resolves.toEqual({ success: true, updated: user.id });

      const remainingMembership = await db.query.organization_memberships.findFirst({
        where: and(
          eq(organization_memberships.organization_id, testOrganization.id),
          eq(organization_memberships.kilo_user_id, user.id)
        ),
      });
      expect(remainingMembership).toBeUndefined();
      expect(invalidateOrganizationSessionAccess).toHaveBeenCalledWith(
        user.id,
        testOrganization.id
      );
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

    it('refuses to remove a service account member', async () => {
      const botUser = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@service-account-remove.example.com`,
        google_user_name: 'Service Account Remove Target',
        is_bot: true,
      });
      await addUserToOrganization(testOrganization.id, botUser.id, 'member');
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.organizations.members.remove({
          organizationId: testOrganization.id,
          memberId: botUser.id,
        })
      ).rejects.toThrow('Service account users cannot be removed');

      const membership = await db.query.organization_memberships.findFirst({
        where: and(
          eq(organization_memberships.organization_id, testOrganization.id),
          eq(organization_memberships.kilo_user_id, botUser.id)
        ),
      });
      expect(membership).toBeDefined();
    });

    it('writes a remove audit row naming the actor and the removed member', async () => {
      const targetUser = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@remove-audit.example.com`,
        google_user_name: 'Remove Audit Target',
        is_admin: false,
      });
      await addUserToOrganization(testOrganization.id, targetUser.id, 'member');
      const caller = await createCallerForUser(regularUser.id);

      await caller.organizations.members.remove({
        organizationId: testOrganization.id,
        memberId: targetUser.id,
      });

      const auditRows = await db
        .select()
        .from(organization_audit_logs)
        .where(
          and(
            eq(organization_audit_logs.organization_id, testOrganization.id),
            eq(organization_audit_logs.action, 'organization.member.remove'),
            eq(organization_audit_logs.message, `Removed user ${targetUser.google_user_email}`)
          )
        );
      expect(auditRows).toEqual([
        expect.objectContaining({
          actor_id: regularUser.id,
          actor_email: regularUser.google_user_email,
          actor_name: regularUser.google_user_name,
        }),
      ]);
    });

    it('lets an organization admin remove a non-owner member', async () => {
      const targetUser = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@org-admin-remove-member.example.com`,
        google_user_name: 'Org Admin Remove Member Target',
        is_admin: false,
      });
      await addUserToOrganization(testOrganization.id, targetUser.id, 'member');

      const caller = await createCallerForUser(orgAdminUser.id);

      const result = await caller.organizations.members.remove({
        organizationId: testOrganization.id,
        memberId: targetUser.id,
      });

      expect(result).toEqual({ success: true, updated: targetUser.id });
    });

    it('rejects an organization admin removing an owner', async () => {
      const targetUser = await insertTestUser({
        google_user_email: `${crypto.randomUUID()}@org-admin-remove-owner.example.com`,
        google_user_name: 'Org Admin Remove Owner Target',
        is_admin: false,
      });
      await addUserToOrganization(testOrganization.id, targetUser.id, 'owner');

      const caller = await createCallerForUser(orgAdminUser.id);

      await expect(
        caller.organizations.members.remove({
          organizationId: testOrganization.id,
          memberId: targetUser.id,
        })
      ).rejects.toThrow('Only an organization owner can manage owners');
    });

    it('should reject billing managers removing owners', async () => {
      const caller = await createCallerForUser(billingManagerUser.id);

      await expect(
        caller.organizations.members.remove({
          organizationId: testOrganization.id,
          memberId: regularUser.id,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
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
      expect(result).toHaveProperty('invitationId');
      expect(result).toHaveProperty('emailStatus', 'pending');
    });

    it('writes an invitation and outbox row and does not send mail in the mutation', async () => {
      const sendInviteEmail = jest.mocked(sendOrganizationInviteEmail);
      sendInviteEmail.mockClear();

      const caller = await createCallerForUser(regularUser.id);
      const email = `${crypto.randomUUID()}@outbox-invite.example.com`;

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email,
        role: 'member',
      });

      expect(sendInviteEmail).not.toHaveBeenCalled();

      const outboxRows = await db
        .select()
        .from(external_side_effect_outbox)
        .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0].status).toBe('pending');
      expect(outboxRows[0].payload.to).toBe(email);
    });

    it('drain sends the invite email once and marks the row delivered', async () => {
      const sendInviteEmail = jest.mocked(sendOrganizationInviteEmail);
      sendInviteEmail.mockClear();

      const caller = await createCallerForUser(regularUser.id);
      const email = `${crypto.randomUUID()}@drain-invite.example.com`;

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email,
        role: 'member',
      });

      expect(sendInviteEmail).not.toHaveBeenCalled();

      await dispatchQueuedInviteEmails();

      const [outboxRow] = await db
        .select()
        .from(external_side_effect_outbox)
        .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));

      expect(outboxRow.status).toBe('delivered');
      expect(sendInviteEmail).toHaveBeenCalledWith(expect.objectContaining({ to: email }));
    });

    it('does not send the invite email after the invitation is accepted', async () => {
      const sendInviteEmail = jest.mocked(sendOrganizationInviteEmail);
      sendInviteEmail.mockClear();

      const caller = await createCallerForUser(regularUser.id);
      const email = `${crypto.randomUUID()}@accepted-before-drain.example.com`;

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email,
        role: 'member',
      });

      // Accept the invitation before the cron pass: this sets `accepted_at`
      // while the outbox row is still `pending`.
      await db
        .update(organization_invitations)
        .set({ accepted_at: sql`NOW()` })
        .where(eq(organization_invitations.id, result.invitationId));

      await dispatchQueuedInviteEmails();

      expect(sendInviteEmail).not.toHaveBeenCalled();

      const [outboxRow] = await db
        .select()
        .from(external_side_effect_outbox)
        .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));
      expect(outboxRow.status).toBe('pending');
    });

    it('resendInvite resets the same outbox row without inserting a second', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const email = `${crypto.randomUUID()}@resend-invite.example.com`;

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email,
        role: 'member',
      });

      // Simulate a terminal failure after 8 attempts.
      await db
        .update(external_side_effect_outbox)
        .set({ status: 'failed', attempts: 8, last_error: 'send failed' })
        .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));

      const resendResult = await caller.organizations.members.resendInvite({
        organizationId: testOrganization.id,
        inviteId: result.invitationId,
      });

      expect(resendResult).toEqual({ success: true, updated: result.invitationId });

      const outboxRows = await db
        .select()
        .from(external_side_effect_outbox)
        .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));

      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0].status).toBe('pending');
      expect(outboxRows[0].attempts).toBe(0);
      expect(outboxRows[0].last_error).toBeNull();
    });

    it('resendInvite refuses a revoked invitation and leaves the outbox row terminal', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const email = `${crypto.randomUUID()}@resend-after-revoke.example.com`;

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email,
        role: 'member',
      });

      await caller.organizations.members.deleteInvite({
        organizationId: testOrganization.id,
        inviteId: result.invitationId,
      });

      await expect(
        caller.organizations.members.resendInvite({
          organizationId: testOrganization.id,
          inviteId: result.invitationId,
        })
      ).rejects.toThrow('This invitation has expired');

      // The revoked invitation's outbox row must stay terminal: no re-arm.
      const [outboxRow] = await db
        .select()
        .from(external_side_effect_outbox)
        .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));
      expect(outboxRow.status).toBe('failed');
      expect(outboxRow.last_error).toBe('revoked');
    });

    it('resetInviteEmailForResend does not re-arm a revoked invitation outbox row', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const email = `${crypto.randomUUID()}@reset-fence-revoke.example.com`;

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email,
        role: 'member',
      });

      // Revoke the invitation: this expires the invitation and marks the outbox
      // row `failed` atomically.
      await caller.organizations.members.deleteInvite({
        organizationId: testOrganization.id,
        inviteId: result.invitationId,
      });

      // Call the DB reset directly, bypassing the router-level guard, to prove
      // the fence itself refuses a revoked invitation.
      const reset = await resetInviteEmailForResend(db, result.invitationId);

      expect(reset).toBeNull();

      const [outboxRow] = await db
        .select()
        .from(external_side_effect_outbox)
        .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));
      expect(outboxRow.status).toBe('failed');
      expect(outboxRow.last_error).toBe('revoked');
    });

    it('resetInviteEmailForResend returns null when the outbox row is sending', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const email = `${crypto.randomUUID()}@reset-fence-sending.example.com`;

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email,
        role: 'member',
      });

      // Simulate a drainer holding a `sending` claim.
      await db
        .update(external_side_effect_outbox)
        .set({ status: 'sending', claimed_at: sql`NOW()` })
        .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));

      const reset = await resetInviteEmailForResend(db, result.invitationId);

      expect(reset).toBeNull();

      const [outboxRow] = await db
        .select()
        .from(external_side_effect_outbox)
        .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));
      expect(outboxRow.status).toBe('sending');
    });

    it('resendInvite refuses an expired invitation and does not reset the outbox row', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const email = `${crypto.randomUUID()}@resend-after-expiry.example.com`;

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email,
        role: 'member',
      });

      // Simulate a terminal send failure, then expiry.
      await db
        .update(external_side_effect_outbox)
        .set({ status: 'failed', attempts: 8, last_error: 'send failed' })
        .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));
      await db
        .update(organization_invitations)
        .set({ expires_at: sql`NOW() - interval '1 hour'` })
        .where(eq(organization_invitations.id, result.invitationId));

      await expect(
        caller.organizations.members.resendInvite({
          organizationId: testOrganization.id,
          inviteId: result.invitationId,
        })
      ).rejects.toThrow('This invitation has expired');

      const [outboxRow] = await db
        .select()
        .from(external_side_effect_outbox)
        .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));
      expect(outboxRow.status).toBe('failed');
      expect(outboxRow.attempts).toBe(8);
      expect(outboxRow.last_error).toBe('send failed');
    });

    it('resendInvite refuses an already-accepted invitation', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const email = `${crypto.randomUUID()}@resend-after-accept.example.com`;

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email,
        role: 'member',
      });

      await db
        .update(organization_invitations)
        .set({ accepted_at: sql`NOW()` })
        .where(eq(organization_invitations.id, result.invitationId));

      await expect(
        caller.organizations.members.resendInvite({
          organizationId: testOrganization.id,
          inviteId: result.invitationId,
        })
      ).rejects.toThrow('This invitation has already been accepted');
    });

    it('marks the outbox row failed after eight send failures and leaves the invitation unchanged', async () => {
      const sendInviteEmail = jest.mocked(sendOrganizationInviteEmail);
      sendInviteEmail.mockRejectedValue(new Error('send failed'));

      const caller = await createCallerForUser(regularUser.id);
      const email = `${crypto.randomUUID()}@eight-failures.example.com`;

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email,
        role: 'member',
      });

      try {
        // Drive eight send failures. Each drain claims the pending row, fails the
        // send, and backs off; clearing `next_attempt_at` makes the next pass
        // claim it again. The eighth failure transitions the row to `failed`.
        for (let i = 0; i < 8; i++) {
          await dispatchQueuedInviteEmails();
          await db
            .update(external_side_effect_outbox)
            .set({ next_attempt_at: null })
            .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));
        }

        const [outboxRow] = await db
          .select()
          .from(external_side_effect_outbox)
          .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));

        expect(outboxRow.status).toBe('failed');
        expect(outboxRow.attempts).toBe(8);

        // The invitation row is untouched: still pending, not accepted, not expired.
        const [invitation] = await db
          .select()
          .from(organization_invitations)
          .where(eq(organization_invitations.id, result.invitationId));
        expect(invitation.accepted_at).toBeNull();
        expect(new Date(invitation.expires_at).getTime()).toBeGreaterThan(Date.now());
      } finally {
        sendInviteEmail.mockResolvedValue({ sent: true });
      }
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

    it('should allow an organization admin to invite an admin', async () => {
      const caller = await createCallerForUser(orgAdminUser.id);

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email: `${crypto.randomUUID()}@org-admin-invite-admin.example.com`,
        role: 'admin',
      });

      expect(result).toHaveProperty('acceptInviteUrl');
    });

    it('should reject an organization admin inviting an owner', async () => {
      const caller = await createCallerForUser(orgAdminUser.id);

      await expect(
        caller.organizations.members.invite({
          organizationId: testOrganization.id,
          email: `${crypto.randomUUID()}@org-admin-invite-owner.example.com`,
          role: 'owner',
        })
      ).rejects.toThrow('Only an organization owner can manage owners');
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

    it('should reject inviting members into a child organization', async () => {
      const childOrg = await createOrganization('Child Members Organization', regularUser.id);
      await db
        .update(organizations)
        .set({ parent_organization_id: testOrganization.id })
        .where(eq(organizations.id, childOrg.id));

      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.organizations.members.invite({
          organizationId: childOrg.id,
          email: 'child-org-invite@example.com',
          role: 'member',
        })
      ).rejects.toThrow('Child organizations manage membership through their parent organization.');
    });

    it('should reject billing managers inviting owners', async () => {
      const caller = await createCallerForUser(billingManagerUser.id);

      await expect(
        caller.organizations.members.invite({
          organizationId: testOrganization.id,
          email: `${crypto.randomUUID()}@billing-manager-owner-invite.example.com`,
          role: 'owner',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should allow billing managers inviting members', async () => {
      const caller = await createCallerForUser(billingManagerUser.id);

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email: `${crypto.randomUUID()}@billing-manager-member-invite.example.com`,
        role: 'member',
      });

      expect(result).toHaveProperty('acceptInviteUrl');
      expect(result.acceptInviteUrl).toMatch(/^https?:\/\/.+\/users\/accept-invite\/.+$/);
    });

    it('should reject billing managers inviting billing managers', async () => {
      const caller = await createCallerForUser(billingManagerUser.id);

      await expect(
        caller.organizations.members.invite({
          organizationId: testOrganization.id,
          email: `${crypto.randomUUID()}@billing-manager-billing-invite.example.com`,
          role: 'billing_manager',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
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

    it('revoked invitation never produces a later invite email', async () => {
      const sendInviteEmail = jest.mocked(sendOrganizationInviteEmail);
      sendInviteEmail.mockClear();

      const caller = await createCallerForUser(regularUser.id);
      const email = `${crypto.randomUUID()}@revoke-no-mail.example.com`;

      const result = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email,
        role: 'member',
      });

      await caller.organizations.members.deleteInvite({
        organizationId: testOrganization.id,
        inviteId: result.invitationId,
      });

      await dispatchQueuedInviteEmails();

      // The revoked invitation's email must never be sent, even though the drain
      // may still deliver other pending rows.
      expect(sendInviteEmail).not.toHaveBeenCalledWith(expect.objectContaining({ to: email }));

      const [outboxRow] = await db
        .select()
        .from(external_side_effect_outbox)
        .where(eq(external_side_effect_outbox.invitation_id, result.invitationId));
      expect(outboxRow.status).toBe('failed');
      expect(outboxRow.last_error).toBe('revoked');
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

    it('should reject billing managers deleting invitations', async () => {
      const ownerCaller = await createCallerForUser(regularUser.id);
      const invitedEmail = `${crypto.randomUUID()}@billing-manager-delete-invite.example.com`;
      await ownerCaller.organizations.members.invite({
        organizationId: testOrganization.id,
        email: invitedEmail,
        role: 'member',
      });

      const { db } = await import('@/lib/drizzle');
      const { organization_invitations } = await import('@kilocode/db/schema');
      const { eq, and } = await import('drizzle-orm');

      const invitation = await db
        .select()
        .from(organization_invitations)
        .where(
          and(
            eq(organization_invitations.organization_id, testOrganization.id),
            eq(organization_invitations.email, invitedEmail)
          )
        )
        .limit(1);

      const caller = await createCallerForUser(billingManagerUser.id);

      await expect(
        caller.organizations.members.deleteInvite({
          organizationId: testOrganization.id,
          inviteId: invitation[0].id,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
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

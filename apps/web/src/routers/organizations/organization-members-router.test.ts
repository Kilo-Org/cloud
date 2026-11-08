import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  createOrganization,
  addUserToOrganization,
  updateUserRoleInOrganization,
} from '@kilocode/web-shared/lib/organizations/organizations';
import {
  admin_action_audit_logs,
  organization_audit_logs,
  organization_group_policy_settings,
  organization_invitations,
  organization_membership_removals,
  organization_memberships,
  organizations,
  external_side_effect_outbox,
  support_access_grants,
  type User,
  type Organization,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { invalidateOrganizationSessionAccess } from '@/lib/session-ingest-client';
import { createAuditLog } from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import type * as OrganizationAuditLogsModule from '@kilocode/web-shared/lib/organizations/organization-audit-logs';
import {
  bumpOrganizationGroupPolicyRevision,
  lockOrganizationGroupPolicy,
} from '@kilocode/web-shared/lib/organizations/organization-groups';
import { sendOrganizationInviteEmail } from '@kilocode/web-shared/lib/email';
import { dispatchQueuedInviteEmails } from '@/lib/organizations/dispatch-invite-email-outbox';
import { resetInviteEmailForResend } from '@kilocode/db/external-side-effect-outbox';

function enableSupportAccess(enabled: boolean) {
  if (enabled) process.env.SUPPORT_ACCESS_ENABLED = 'true';
  else delete process.env.SUPPORT_ACCESS_ENABLED;
}

jest.mock('@/lib/session-ingest-client', () => ({
  invalidateOrganizationSessionAccess: jest.fn().mockResolvedValue(undefined),
}));

// Mock `updateUserRoleInOrganization` so the failed-role-update test can drive a
// failure inside the transaction while every other test keeps the real
// implementation. SWC makes ESM exports non-configurable, so `jest.spyOn` on the
// named export fails; replace it on the module instead.
jest.mock('@kilocode/web-shared/lib/organizations/organizations', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@kilocode/web-shared/lib/organizations/organizations'
  );
  return {
    ...actual,
    updateUserRoleInOrganization: jest.fn(
      actual.updateUserRoleInOrganization as typeof updateUserRoleInOrganization
    ),
  };
});

jest.mock('@kilocode/web-shared/lib/organizations/organization-audit-logs', () => {
  const actual = jest.requireActual<typeof OrganizationAuditLogsModule>(
    '@kilocode/web-shared/lib/organizations/organization-audit-logs'
  );
  return { ...actual, createAuditLog: jest.fn(actual.createAuditLog) };
});

// Mock the email service to prevent actual API calls during tests
jest.mock('@kilocode/web-shared/lib/email', () => ({
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

  describe('Kilo admin elevated writes', () => {
    async function elevatedAudits(actorId: string, organizationId: string) {
      return db
        .select()
        .from(admin_action_audit_logs)
        .where(
          and(
            eq(admin_action_audit_logs.actor_id, actorId),
            eq(admin_action_audit_logs.target_id, organizationId)
          )
        );
    }

    it('records role changes and self-invites by a non-member Kilo admin', async () => {
      const owner = await insertTestUser({ is_admin: false });
      const organization = await createOrganization('Elevated Audit Org', owner.id);
      const member = await insertTestUser({ is_admin: false });
      await addUserToOrganization(organization.id, member.id, 'member');
      const caller = await createCallerForUser(adminUser.id);

      await caller.organizations.members.update({
        organizationId: organization.id,
        memberId: member.id,
        role: 'admin',
      });
      await caller.organizations.members.invite({
        organizationId: organization.id,
        email: adminUser.google_user_email,
        role: 'owner',
      });

      const audits = await elevatedAudits(adminUser.id, organization.id);
      expect(
        audits.find(audit => audit.action === 'organization.member.role.update')
      ).toMatchObject({
        target_type: 'organization',
        metadata: {
          memberKiloUserId: member.id,
          previousRole: 'member',
          role: 'admin',
          heldRoles: [],
        },
      });
      const invite = audits.find(audit => audit.action === 'organization.member.invite');
      expect(invite?.metadata).toMatchObject({
        role: 'owner',
        invitedSelf: true,
        invitedEmailDomain: 'admin.example.com',
      });
      expect(JSON.stringify([invite?.message, invite?.metadata])).not.toContain(
        adminUser.google_user_email
      );
    });

    it('records owner-authority actions by a Kilo admin who only holds the admin role', async () => {
      const owner = await insertTestUser({ is_admin: false });
      const organization = await createOrganization('Owner Authority Org', owner.id);
      const member = await insertTestUser({ is_admin: false });
      await addUserToOrganization(organization.id, member.id, 'member');
      const kiloAdmin = await insertTestUser({
        is_admin: true,
        google_user_email: `kilo-admin-${crypto.randomUUID()}@admin.example.com`,
      });
      await addUserToOrganization(organization.id, kiloAdmin.id, 'admin');
      const caller = await createCallerForUser(kiloAdmin.id);

      await caller.organizations.members.update({
        organizationId: organization.id,
        memberId: member.id,
        role: 'owner',
      });
      const [, domain] = kiloAdmin.google_user_email.split('@');
      await caller.organizations.members.invite({
        organizationId: organization.id,
        email: `new-owner-${crypto.randomUUID()}@${domain}`,
        role: 'owner',
      });

      const audits = await elevatedAudits(kiloAdmin.id, organization.id);
      expect(
        audits.find(a => a.action === 'organization.member.role.update')?.metadata
      ).toMatchObject({ role: 'owner', heldRoles: ['admin'] });
      expect(audits.find(a => a.action === 'organization.member.invite')?.metadata).toMatchObject({
        role: 'owner',
        invitedSelf: false,
      });
    });

    it('records Kilo admin self-removal with the roles held before removal', async () => {
      const owner = await insertTestUser({ is_admin: false });
      const organization = await createOrganization('Self Removal Org', owner.id);
      const kiloAdmin = await insertTestUser({ is_admin: true });
      await addUserToOrganization(organization.id, kiloAdmin.id, 'admin');

      await (
        await createCallerForUser(kiloAdmin.id)
      ).organizations.members.remove({
        organizationId: organization.id,
        memberId: kiloAdmin.id,
      });

      const [audit] = await elevatedAudits(kiloAdmin.id, organization.id);
      expect(audit).toMatchObject({
        action: 'organization.member.remove',
        metadata: { previousRole: 'admin', heldRoles: ['admin'] },
      });
    });

    it('enforce applies the real role and rejects admin self-removal', async () => {
      const owner = await insertTestUser({ is_admin: false });
      const organization = await createOrganization('Enforced Self Removal Org', owner.id);
      const kiloAdmin = await insertTestUser({ is_admin: true });
      await addUserToOrganization(organization.id, kiloAdmin.id, 'admin');
      enableSupportAccess(true);
      try {
        await expect(
          (await createCallerForUser(kiloAdmin.id)).organizations.members.remove({
            organizationId: organization.id,
            memberId: kiloAdmin.id,
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      } finally {
        enableSupportAccess(false);
      }
    });

    it('does not record writes by members acting within their own role', async () => {
      const owner = await insertTestUser({ is_admin: false });
      const organization = await createOrganization('Member Write Org', owner.id);
      const member = await insertTestUser({ is_admin: false });
      await addUserToOrganization(organization.id, member.id, 'member');
      const kiloAdminOwner = await insertTestUser({ is_admin: true });
      await addUserToOrganization(organization.id, kiloAdminOwner.id, 'owner');

      await (
        await createCallerForUser(owner.id)
      ).organizations.members.update({
        organizationId: organization.id,
        memberId: member.id,
        role: 'admin',
      });
      await (
        await createCallerForUser(kiloAdminOwner.id)
      ).organizations.members.update({
        organizationId: organization.id,
        memberId: member.id,
        role: 'member',
      });

      expect(await elevatedAudits(owner.id, organization.id)).toEqual([]);
      expect(await elevatedAudits(kiloAdminOwner.id, organization.id)).toEqual([]);
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

    it('enforce denies an admin with no parent membership', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const child = await createChildOrganization('Enforced Child Members', childOwner.id);
      const kiloAdmin = await insertTestUser({ is_admin: true });
      enableSupportAccess(true);
      try {
        await expect(
          (await createCallerForUser(kiloAdmin.id)).organizations.members.setChildMemberships({
            organizationId: testOrganization.id,
            memberId: memberUser.id,
            childOrganizationIds: [child.id],
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      } finally {
        enableSupportAccess(false);
        await cleanupChildOrganizations([child.id]);
      }
    });

    it('enforce uses a real billing-manager role for an admin', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const child = await createChildOrganization('Enforced Billing Child', childOwner.id);
      const kiloAdmin = await insertTestUser({ is_admin: true });
      await addUserToOrganization(testOrganization.id, kiloAdmin.id, 'billing_manager');
      enableSupportAccess(true);
      try {
        const result = await (
          await createCallerForUser(kiloAdmin.id)
        ).organizations.members.setChildMemberships({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
          childOrganizationIds: [child.id],
        });
        expect(result.added).toEqual([child.id]);
      } finally {
        enableSupportAccess(false);
        await cleanupChildOrganizations([child.id]);
      }
    });

    it('enforce uses a real admin role for an admin', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const target = await insertTestUser({ is_admin: false });
      const child = await createChildOrganization('Enforced Admin Child', childOwner.id);
      const kiloAdmin = await insertTestUser({ is_admin: true });
      await addUserToOrganization(testOrganization.id, target.id, 'member');
      await addUserToOrganization(testOrganization.id, kiloAdmin.id, 'admin');
      enableSupportAccess(true);
      try {
        const caller = await createCallerForUser(kiloAdmin.id);
        const input = { organizationId: testOrganization.id, memberId: target.id };
        await expect(
          caller.organizations.members.setChildMemberships({
            ...input,
            childOrganizationIds: [child.id],
          })
        ).resolves.toEqual({ success: true, added: [child.id], removed: [] });
        await expect(
          caller.organizations.members.setChildMemberships({ ...input, childOrganizationIds: [] })
        ).resolves.toEqual({ success: true, added: [], removed: [child.id] });

        const audits = await db
          .select()
          .from(admin_action_audit_logs)
          .where(
            and(
              eq(admin_action_audit_logs.actor_id, kiloAdmin.id),
              eq(admin_action_audit_logs.target_id, testOrganization.id),
              eq(admin_action_audit_logs.action, 'organization.child_memberships.set')
            )
          );
        expect(audits).toEqual([]);
      } finally {
        enableSupportAccess(false);
        await cleanupChildOrganizations([child.id]);
      }
    });

    it('enforce denies a support write grant without a qualifying parent role', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const target = await insertTestUser({ is_admin: false });
      const child = await createChildOrganization('Enforced Support Child', childOwner.id);
      const kiloAdmin = await insertTestUser({ is_admin: true });
      const approver = await insertTestUser({ is_admin: true });
      await addUserToOrganization(testOrganization.id, target.id, 'member');
      const now = new Date();
      await db.insert(support_access_grants).values({
        actor_kilo_user_id: kiloAdmin.id,
        organization_id: testOrganization.id,
        action_class: 'support_write',
        status: 'active',
        reason: 'investigating a customer report',
        approved_by_kilo_user_id: approver.id,
        decided_at: now.toISOString(),
        requested_duration_seconds: 900,
        issued_at: now.toISOString(),
        expires_at: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
      });
      enableSupportAccess(true);
      try {
        await expect(
          (await createCallerForUser(kiloAdmin.id)).organizations.members.setChildMemberships({
            organizationId: testOrganization.id,
            memberId: target.id,
            childOrganizationIds: [child.id],
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        const membership = await db.query.organization_memberships.findFirst({
          where: and(
            eq(organization_memberships.organization_id, child.id),
            eq(organization_memberships.kilo_user_id, target.id)
          ),
        });
        expect(membership).toBeUndefined();
      } finally {
        enableSupportAccess(false);
        await db
          .delete(support_access_grants)
          .where(eq(support_access_grants.actor_kilo_user_id, kiloAdmin.id));
        await cleanupChildOrganizations([child.id]);
      }
    });

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
        await expect(
          caller.organizations.members.setChildMemberships({
            organizationId: testOrganization.id,
            memberId: memberUser.id,
            childOrganizationIds: [childB.id],
          })
        ).resolves.toEqual({ success: true, added: [], removed: [childA.id] });
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
        await expect(
          caller.organizations.members.setChildMemberships({
            organizationId: testOrganization.id,
            memberId: memberUser.id,
            childOrganizationIds: [],
          })
        ).resolves.toEqual({ success: true, added: [], removed: [child.id] });
      } finally {
        await cleanupChildOrganizations([child.id]);
      }
    });

    it('allows parent admins to add and remove ordinary child memberships', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const target = await insertTestUser({ is_admin: false });
      await addUserToOrganization(testOrganization.id, target.id, 'member');
      const child = await createChildOrganization('Admin Child Members', childOwner.id);
      const caller = await createCallerForUser(orgAdminUser.id);
      const input = { organizationId: testOrganization.id, memberId: target.id };
      jest.mocked(invalidateOrganizationSessionAccess).mockClear();

      try {
        await expect(
          caller.organizations.members.setChildMemberships({
            ...input,
            childOrganizationIds: [child.id],
          })
        ).resolves.toEqual({ success: true, added: [child.id], removed: [] });

        const membership = await db.query.organization_memberships.findFirst({
          where: and(
            eq(organization_memberships.organization_id, child.id),
            eq(organization_memberships.kilo_user_id, target.id)
          ),
        });
        expect(membership?.role).toBe('member');

        await expect(
          caller.organizations.members.setChildMemberships({ ...input, childOrganizationIds: [] })
        ).resolves.toEqual({ success: true, added: [], removed: [child.id] });

        const remainingMembership = await db.query.organization_memberships.findFirst({
          where: and(
            eq(organization_memberships.organization_id, child.id),
            eq(organization_memberships.kilo_user_id, target.id)
          ),
        });
        expect(remainingMembership).toBeUndefined();
        expect(invalidateOrganizationSessionAccess).toHaveBeenCalledWith(target.id, child.id);
      } finally {
        await cleanupChildOrganizations([child.id]);
      }
    });

    it('records only bypassed Kilo admin child-membership writes', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const target = await insertTestUser({ is_admin: false });
      const kiloAdmin = await insertTestUser({ is_admin: true });
      await addUserToOrganization(testOrganization.id, target.id, 'member');
      await addUserToOrganization(testOrganization.id, kiloAdmin.id, 'admin');
      const child = await createChildOrganization('Kilo Admin Child Members', childOwner.id);
      const input = {
        organizationId: testOrganization.id,
        memberId: target.id,
        childOrganizationIds: [child.id],
      };

      try {
        const directAdminCaller = await createCallerForUser(kiloAdmin.id);
        await expect(
          directAdminCaller.organizations.members.setChildMemberships(input)
        ).resolves.toEqual({ success: true, added: [child.id], removed: [] });

        const directAudits = await db
          .select()
          .from(admin_action_audit_logs)
          .where(
            and(
              eq(admin_action_audit_logs.actor_id, kiloAdmin.id),
              eq(admin_action_audit_logs.target_id, testOrganization.id),
              eq(admin_action_audit_logs.action, 'organization.child_memberships.set')
            )
          );
        expect(directAudits).toEqual([]);

        const elevatedCaller = await createCallerForUser(adminUser.id);
        await expect(
          elevatedCaller.organizations.members.setChildMemberships({
            ...input,
            childOrganizationIds: [],
          })
        ).resolves.toEqual({ success: true, added: [], removed: [child.id] });

        const elevatedAudits = await db
          .select()
          .from(admin_action_audit_logs)
          .where(
            and(
              eq(admin_action_audit_logs.actor_id, adminUser.id),
              eq(admin_action_audit_logs.target_id, testOrganization.id),
              eq(admin_action_audit_logs.action, 'organization.child_memberships.set')
            )
          );
        expect(elevatedAudits).toEqual([
          expect.objectContaining({
            metadata: {
              memberKiloUserId: target.id,
              addedOrganizationIds: [],
              removedOrganizationIds: [child.id],
              heldRoles: [],
            },
          }),
        ]);
      } finally {
        await cleanupChildOrganizations([child.id]);
      }
    });

    it('rejects parent members assigning or removing child memberships', async () => {
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
        ).rejects.toMatchObject({
          code: 'UNAUTHORIZED',
          message: 'You do not have the required organizational role to access this feature',
        });
        const deniedAssignment = await db.query.organization_memberships.findFirst({
          where: and(
            eq(organization_memberships.organization_id, child.id),
            eq(organization_memberships.kilo_user_id, memberUser.id)
          ),
        });
        expect(deniedAssignment).toBeUndefined();

        await addUserToOrganization(child.id, billingManagerUser.id, 'member');
        await expect(
          caller.organizations.members.setChildMemberships({
            organizationId: testOrganization.id,
            memberId: billingManagerUser.id,
            childOrganizationIds: [],
          })
        ).rejects.toMatchObject({
          code: 'UNAUTHORIZED',
          message: 'You do not have the required organizational role to access this feature',
        });
        const membership = await db.query.organization_memberships.findFirst({
          where: and(
            eq(organization_memberships.organization_id, child.id),
            eq(organization_memberships.kilo_user_id, billingManagerUser.id)
          ),
        });
        expect(membership?.role).toBe('member');
      } finally {
        await cleanupChildOrganizations([child.id]);
      }
    });

    it('rejects outsiders assigning or removing child memberships', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const target = await insertTestUser({ is_admin: false });
      await addUserToOrganization(testOrganization.id, target.id, 'member');
      const child = await createChildOrganization('Outsider Child Members', childOwner.id);
      const caller = await createCallerForUser(nonMemberUser.id);
      const input = { organizationId: testOrganization.id, memberId: target.id };

      try {
        await expect(
          caller.organizations.members.setChildMemberships({
            ...input,
            childOrganizationIds: [child.id],
          })
        ).rejects.toMatchObject({
          code: 'UNAUTHORIZED',
          message: 'You do not have access to this organization',
        });
        const deniedAssignment = await db.query.organization_memberships.findFirst({
          where: and(
            eq(organization_memberships.organization_id, child.id),
            eq(organization_memberships.kilo_user_id, target.id)
          ),
        });
        expect(deniedAssignment).toBeUndefined();

        await addUserToOrganization(child.id, target.id, 'member');
        await expect(
          caller.organizations.members.setChildMemberships({ ...input, childOrganizationIds: [] })
        ).rejects.toMatchObject({
          code: 'UNAUTHORIZED',
          message: 'You do not have access to this organization',
        });

        const membership = await db.query.organization_memberships.findFirst({
          where: and(
            eq(organization_memberships.organization_id, child.id),
            eq(organization_memberships.kilo_user_id, target.id)
          ),
        });
        expect(membership?.role).toBe('member');
      } finally {
        await cleanupChildOrganizations([child.id]);
      }
    });

    it.each(['owner', 'admin', 'billing_manager'] as const)(
      'rejects an inherited parent %s without a direct privileged membership',
      async role => {
        const grandparentOwner = await insertTestUser({ is_admin: false });
        const actor = await insertTestUser({ is_admin: false });
        const grandparent = await createOrganization('Grandparent Members', grandparentOwner.id);
        const childOwner = await insertTestUser({ is_admin: false });
        const target = await insertTestUser({ is_admin: false });
        await addUserToOrganization(grandparent.id, actor.id, role);
        await addUserToOrganization(testOrganization.id, target.id, 'member');
        const child = await createChildOrganization('Inherited Actor Child Members', childOwner.id);
        const caller = await createCallerForUser(actor.id);

        try {
          await db
            .update(organizations)
            .set({ parent_organization_id: grandparent.id })
            .where(eq(organizations.id, testOrganization.id));
          await expect(
            caller.organizations.members.setChildMemberships({
              organizationId: testOrganization.id,
              memberId: target.id,
              childOrganizationIds: [child.id],
            })
          ).rejects.toMatchObject({
            code: 'UNAUTHORIZED',
            message: 'You do not have the required organizational role to access this feature',
          });

          await addUserToOrganization(testOrganization.id, actor.id, 'member');
          await expect(
            caller.organizations.members.setChildMemberships({
              organizationId: testOrganization.id,
              memberId: target.id,
              childOrganizationIds: [child.id],
            })
          ).rejects.toMatchObject({
            code: 'UNAUTHORIZED',
            message: 'You do not have the required organizational role to access this feature',
          });

          const membership = await db.query.organization_memberships.findFirst({
            where: and(
              eq(organization_memberships.organization_id, child.id),
              eq(organization_memberships.kilo_user_id, target.id)
            ),
          });
          expect(membership).toBeUndefined();
        } finally {
          await cleanupChildOrganizations([child.id]);
          await db
            .update(organizations)
            .set({ parent_organization_id: null })
            .where(eq(organizations.id, testOrganization.id));
          await db.delete(organizations).where(eq(organizations.id, grandparent.id));
        }
      }
    );

    it('rejects parent admins assigning service accounts', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const bot = await insertTestUser({ is_bot: true });
      await addUserToOrganization(testOrganization.id, bot.id, 'member');
      const child = await createChildOrganization('Bot Child Members', childOwner.id);
      const caller = await createCallerForUser(orgAdminUser.id);

      try {
        await expect(
          caller.organizations.members.setChildMemberships({
            organizationId: testOrganization.id,
            memberId: bot.id,
            childOrganizationIds: [child.id],
          })
        ).rejects.toMatchObject({
          code: 'NOT_FOUND',
          message: 'User is not a member of the parent organization',
        });

        const membership = await db.query.organization_memberships.findFirst({
          where: and(
            eq(organization_memberships.organization_id, child.id),
            eq(organization_memberships.kilo_user_id, bot.id)
          ),
        });
        expect(membership).toBeUndefined();
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
      const caller = await createCallerForUser(orgAdminUser.id);

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
      const caller = await createCallerForUser(orgAdminUser.id);

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

    it.each(['owner', 'admin', 'billing_manager'] as const)(
      'rejects a billing manager omitting a child %s membership without partial changes',
      async role => {
        const childOwner = await insertTestUser({ is_admin: false });
        const elevatedChild = await createChildOrganization('Elevated Child', childOwner.id);
        const existingChild = await createChildOrganization('Existing Member Child', childOwner.id);
        const newChild = await createChildOrganization('New Member Child', childOwner.id);
        const childIds = [elevatedChild.id, existingChild.id, newChild.id];
        await addUserToOrganization(elevatedChild.id, memberUser.id, role);
        await addUserToOrganization(existingChild.id, memberUser.id, 'member');
        jest.mocked(invalidateOrganizationSessionAccess).mockClear();
        const caller = await createCallerForUser(billingManagerUser.id);

        try {
          await expect(
            caller.organizations.members.setChildMemberships({
              organizationId: testOrganization.id,
              memberId: memberUser.id,
              childOrganizationIds: [newChild.id],
            })
          ).rejects.toMatchObject({
            code: 'FORBIDDEN',
            message: 'Elevated child team memberships must be managed in the child team',
          });

          const rows = await db
            .select({
              organizationId: organization_memberships.organization_id,
              role: organization_memberships.role,
            })
            .from(organization_memberships)
            .where(
              and(
                eq(organization_memberships.kilo_user_id, memberUser.id),
                inArray(organization_memberships.organization_id, childIds)
              )
            );
          expect(rows).toEqual(
            expect.arrayContaining([
              { organizationId: elevatedChild.id, role },
              { organizationId: existingChild.id, role: 'member' },
            ])
          );
          expect(rows).toHaveLength(2);
          const audits = await db
            .select()
            .from(organization_audit_logs)
            .where(inArray(organization_audit_logs.organization_id, childIds));
          expect(audits).toEqual([]);
          expect(invalidateOrganizationSessionAccess).not.toHaveBeenCalled();
        } finally {
          await cleanupChildOrganizations(childIds);
        }
      }
    );

    it.each([
      ['parent owner', () => regularUser.id],
      ['Kilo admin', () => adminUser.id],
    ])('rejects an omitted elevated membership for a %s', async (_label, getActorId) => {
      const childOwner = await insertTestUser({ is_admin: false });
      const child = await createChildOrganization('Protected Child', childOwner.id);
      await addUserToOrganization(child.id, memberUser.id, 'owner');
      const caller = await createCallerForUser(getActorId());
      jest.mocked(invalidateOrganizationSessionAccess).mockClear();
      const readActorAudits = () =>
        db
          .select({ id: admin_action_audit_logs.id })
          .from(admin_action_audit_logs)
          .where(
            and(
              eq(admin_action_audit_logs.actor_id, getActorId()),
              eq(admin_action_audit_logs.target_id, testOrganization.id),
              eq(admin_action_audit_logs.action, 'organization.child_memberships.set')
            )
          )
          .orderBy(admin_action_audit_logs.id);

      try {
        const auditsBefore = await readActorAudits();
        await expect(
          caller.organizations.members.setChildMemberships({
            organizationId: testOrganization.id,
            memberId: memberUser.id,
            childOrganizationIds: [],
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });

        const membership = await db.query.organization_memberships.findFirst({
          where: and(
            eq(organization_memberships.organization_id, child.id),
            eq(organization_memberships.kilo_user_id, memberUser.id)
          ),
        });
        expect(membership?.role).toBe('owner');
        expect(invalidateOrganizationSessionAccess).not.toHaveBeenCalled();
        expect(await readActorAudits()).toEqual(auditsBefore);
      } finally {
        await cleanupChildOrganizations([child.id]);
      }
    });

    it('removes a member while retaining a selected elevated child membership', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const elevatedChild = await createChildOrganization('Selected Elevated Child', childOwner.id);
      const memberChild = await createChildOrganization('Removable Member Child', childOwner.id);
      const newChild = await createChildOrganization('Added Member Child', childOwner.id);
      const childIds = [elevatedChild.id, memberChild.id, newChild.id];
      await addUserToOrganization(elevatedChild.id, memberUser.id, 'admin');
      await addUserToOrganization(memberChild.id, memberUser.id, 'member');
      jest.mocked(invalidateOrganizationSessionAccess).mockClear();
      const caller = await createCallerForUser(billingManagerUser.id);

      try {
        const result = await caller.organizations.members.setChildMemberships({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
          childOrganizationIds: [elevatedChild.id, newChild.id],
        });

        expect(result).toEqual({ success: true, added: [newChild.id], removed: [memberChild.id] });
        const rows = await db
          .select({
            organizationId: organization_memberships.organization_id,
            role: organization_memberships.role,
          })
          .from(organization_memberships)
          .where(
            and(
              eq(organization_memberships.kilo_user_id, memberUser.id),
              inArray(organization_memberships.organization_id, childIds)
            )
          );
        expect(rows).toEqual(
          expect.arrayContaining([
            { organizationId: elevatedChild.id, role: 'admin' },
            { organizationId: newChild.id, role: 'member' },
          ])
        );
        expect(rows).toHaveLength(2);
        const audits = await db
          .select({
            organizationId: organization_audit_logs.organization_id,
            action: organization_audit_logs.action,
          })
          .from(organization_audit_logs)
          .where(inArray(organization_audit_logs.organization_id, childIds));
        expect(audits).toEqual(
          expect.arrayContaining([
            { organizationId: newChild.id, action: 'organization.member.admin_add' },
            { organizationId: memberChild.id, action: 'organization.member.remove' },
          ])
        );
        expect(audits).toHaveLength(2);
        expect(invalidateOrganizationSessionAccess).toHaveBeenCalledTimes(1);
        expect(invalidateOrganizationSessionAccess).toHaveBeenCalledWith(
          memberUser.id,
          memberChild.id
        );
      } finally {
        await cleanupChildOrganizations(childIds);
      }
    });

    it.each([
      { role: 'owner', outcome: 'commit' },
      { role: 'admin', outcome: 'commit' },
      { role: 'billing_manager', outcome: 'commit' },
      { role: 'owner', outcome: 'rollback' },
      { role: 'admin', outcome: 'rollback' },
      { role: 'billing_manager', outcome: 'rollback' },
    ] as const)(
      'waits for the $outcome of a concurrent $role demotion before deciding removal',
      async ({ role, outcome }) => {
        const childOwner = await insertTestUser({ is_admin: false });
        const child = await createChildOrganization('Concurrent Demotion Child', childOwner.id);
        await addUserToOrganization(child.id, memberUser.id, role);
        const caller = await createCallerForUser(billingManagerUser.id);
        jest.mocked(invalidateOrganizationSessionAccess).mockClear();
        const demoted = Promise.withResolvers<number>();
        const allowCompletion = Promise.withResolvers<void>();
        const rollbackError = new Error('Demotion rolled back');
        const demotion = db
          .transaction(async tx => {
            await updateUserRoleInOrganization(child.id, memberUser.id, 'member', tx);
            const result = await tx.execute<{ pid: number }>(
              sql`SELECT pg_backend_pid()::int AS pid`
            );
            const pid = result.rows[0]?.pid;
            if (pid === undefined) throw new Error('PostgreSQL backend pid unavailable');
            demoted.resolve(pid);
            await allowCompletion.promise;
            if (outcome === 'rollback') throw rollbackError;
          })
          .then(
            value => ({ value }),
            (error: unknown) => {
              demoted.reject(error);
              return { error };
            }
          );
        const holderPid = await demoted.promise;
        let requestFinished = false;
        const attempt = caller.organizations.members
          .setChildMemberships({
            organizationId: testOrganization.id,
            memberId: memberUser.id,
            childOrganizationIds: [],
          })
          .then(
            value => {
              requestFinished = true;
              return { value };
            },
            (error: unknown) => {
              requestFinished = true;
              return { error };
            }
          );

        try {
          let blocked = false;
          for (let i = 0; i < 2000 && !blocked && !requestFinished; i += 1) {
            const waiting = await db.execute(sql`
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND ${holderPid} = ANY(pg_blocking_pids(pid))
            `);
            blocked = waiting.rows.length > 0;
            if (!blocked) await new Promise<void>(resolve => setImmediate(resolve));
          }
          expect(blocked).toBe(true);
          expect(requestFinished).toBe(false);
          allowCompletion.resolve();

          if (outcome === 'commit') {
            expect(await demotion).toEqual({ value: undefined });
            expect(await attempt).toEqual({
              value: { success: true, added: [], removed: [child.id] },
            });
          } else {
            expect(await demotion).toEqual({ error: rollbackError });
            expect(await attempt).toMatchObject({
              error: {
                code: 'FORBIDDEN',
                message: 'Elevated child team memberships must be managed in the child team',
              },
            });
          }

          const membership = await db.query.organization_memberships.findFirst({
            where: and(
              eq(organization_memberships.organization_id, child.id),
              eq(organization_memberships.kilo_user_id, memberUser.id)
            ),
          });
          const audits = await db
            .select({ action: organization_audit_logs.action })
            .from(organization_audit_logs)
            .where(eq(organization_audit_logs.organization_id, child.id));
          const removals = await db
            .select()
            .from(organization_membership_removals)
            .where(eq(organization_membership_removals.organization_id, child.id));

          if (outcome === 'commit') {
            expect(membership).toBeUndefined();
            expect(audits).toEqual([{ action: 'organization.member.remove' }]);
            expect(removals).toHaveLength(1);
            expect(invalidateOrganizationSessionAccess).toHaveBeenCalledTimes(1);
            expect(invalidateOrganizationSessionAccess).toHaveBeenCalledWith(
              memberUser.id,
              child.id
            );
          } else {
            expect(membership?.role).toBe(role);
            expect(audits).toEqual([]);
            expect(removals).toEqual([]);
            expect(invalidateOrganizationSessionAccess).not.toHaveBeenCalled();
          }
        } finally {
          allowCompletion.resolve();
          await demotion;
          await attempt;
          await cleanupChildOrganizations([child.id]);
        }
      },
      20_000
    );

    it('rolls back earlier changes when a later omitted membership is elevated', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const children = await Promise.all([
        createChildOrganization('Earlier Addition Child', childOwner.id),
        createChildOrganization('Earlier Removal Child', childOwner.id),
        createChildOrganization('Later Elevated Child', childOwner.id),
      ]);
      const childIds = children.map(child => child.id).sort();
      const [addedChildId, removedChildId, elevatedChildId] = childIds;
      if (!addedChildId || !removedChildId || !elevatedChildId) {
        throw new Error('Child organization IDs unavailable');
      }
      await addUserToOrganization(removedChildId, memberUser.id, 'member');
      await addUserToOrganization(elevatedChildId, memberUser.id, 'admin');
      const caller = await createCallerForUser(billingManagerUser.id);
      const createAudit = jest.mocked(createAuditLog);
      createAudit.mockClear();
      jest.mocked(invalidateOrganizationSessionAccess).mockClear();

      try {
        await expect(
          caller.organizations.members.setChildMemberships({
            organizationId: testOrganization.id,
            memberId: memberUser.id,
            childOrganizationIds: [addedChildId],
          })
        ).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(createAudit).toHaveBeenCalledTimes(2);
        expect(createAudit).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            action: 'organization.member.admin_add',
            organization_id: addedChildId,
          })
        );
        expect(createAudit).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            action: 'organization.member.remove',
            organization_id: removedChildId,
          })
        );

        const memberships = await db
          .select({
            organizationId: organization_memberships.organization_id,
            role: organization_memberships.role,
          })
          .from(organization_memberships)
          .where(
            and(
              eq(organization_memberships.kilo_user_id, memberUser.id),
              inArray(organization_memberships.organization_id, childIds)
            )
          )
          .orderBy(organization_memberships.organization_id);
        expect(memberships).toEqual([
          { organizationId: removedChildId, role: 'member' },
          { organizationId: elevatedChildId, role: 'admin' },
        ]);
        const audits = await db
          .select()
          .from(organization_audit_logs)
          .where(inArray(organization_audit_logs.organization_id, childIds));
        const removals = await db
          .select()
          .from(organization_membership_removals)
          .where(inArray(organization_membership_removals.organization_id, childIds));
        expect(audits).toEqual([]);
        expect(removals).toEqual([]);
        expect(invalidateOrganizationSessionAccess).not.toHaveBeenCalled();
      } finally {
        await cleanupChildOrganizations(childIds);
      }
    });

    it('refuses removal when a concurrent child role promotion commits first', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const existingChild = await createChildOrganization(
        'Concurrent Promotion Child',
        childOwner.id
      );
      const newChild = await createChildOrganization('Concurrent Addition Child', childOwner.id);
      const childIds = [existingChild.id, newChild.id];
      await addUserToOrganization(existingChild.id, memberUser.id, 'member');
      const caller = await createCallerForUser(billingManagerUser.id);
      jest.mocked(invalidateOrganizationSessionAccess).mockClear();
      const promoted = Promise.withResolvers<number>();
      const allowCommit = Promise.withResolvers<void>();
      const promotion = db.transaction(async tx => {
        await tx
          .update(organization_memberships)
          .set({ role: 'admin' })
          .where(
            and(
              eq(organization_memberships.organization_id, existingChild.id),
              eq(organization_memberships.kilo_user_id, memberUser.id)
            )
          );
        const result = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
        const pid = result.rows[0]?.pid;
        if (pid === undefined) throw new Error('PostgreSQL backend pid unavailable');
        promoted.resolve(pid);
        await allowCommit.promise;
      });
      const holderPid = await promoted.promise;
      const attempt = caller.organizations.members
        .setChildMemberships({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
          childOrganizationIds: [newChild.id],
        })
        .then(
          value => ({ value }),
          (error: unknown) => ({ error })
        );

      try {
        let blocked = false;
        for (let i = 0; i < 2000 && !blocked; i += 1) {
          const waiting = await db.execute(sql`
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND ${holderPid} = ANY(pg_blocking_pids(pid))
          `);
          blocked = waiting.rows.length > 0;
          if (!blocked) await new Promise<void>(resolve => setImmediate(resolve));
        }
        expect(blocked).toBe(true);
        allowCommit.resolve();
        await promotion;
        expect(await attempt).toMatchObject({
          error: {
            code: 'FORBIDDEN',
            message: 'Elevated child team memberships must be managed in the child team',
          },
        });
        const rows = await db
          .select({
            organizationId: organization_memberships.organization_id,
            role: organization_memberships.role,
          })
          .from(organization_memberships)
          .where(
            and(
              eq(organization_memberships.kilo_user_id, memberUser.id),
              inArray(organization_memberships.organization_id, childIds)
            )
          );
        expect(rows).toEqual([{ organizationId: existingChild.id, role: 'admin' }]);
        const audits = await db
          .select()
          .from(organization_audit_logs)
          .where(inArray(organization_audit_logs.organization_id, childIds));
        expect(audits).toEqual([]);
        expect(invalidateOrganizationSessionAccess).not.toHaveBeenCalled();
      } finally {
        allowCommit.resolve();
        await promotion;
        await attempt;
        await cleanupChildOrganizations(childIds);
      }
    }, 20_000);

    it('completes concurrent additions without reversing policy and membership locks', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const child = await createChildOrganization('Concurrent Membership Addition', childOwner.id);
      const caller = await createCallerForUser(billingManagerUser.id);
      const inserted = Promise.withResolvers<number>();
      const allowPolicyUpdate = Promise.withResolvers<void>();
      const competingAddition = db.transaction(async tx => {
        await tx.insert(organization_memberships).values({
          organization_id: child.id,
          kilo_user_id: memberUser.id,
          role: 'admin',
        });
        const result = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
        const pid = result.rows[0]?.pid;
        if (pid === undefined) throw new Error('PostgreSQL backend pid unavailable');
        inserted.resolve(pid);
        await allowPolicyUpdate.promise;
        await bumpOrganizationGroupPolicyRevision(tx, child.id, childOwner.id);
      });
      const holderPid = await inserted.promise;
      const attempt = caller.organizations.members
        .setChildMemberships({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
          childOrganizationIds: [child.id],
        })
        .then(
          value => ({ value }),
          (error: unknown) => ({ error })
        );

      try {
        let blocked = false;
        for (let i = 0; i < 2000 && !blocked; i += 1) {
          const waiting = await db.execute(sql`
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND ${holderPid} = ANY(pg_blocking_pids(pid))
          `);
          blocked = waiting.rows.length > 0;
          if (!blocked) await new Promise<void>(resolve => setImmediate(resolve));
        }
        expect(blocked).toBe(true);
        allowPolicyUpdate.resolve();
        await expect(competingAddition).resolves.toBeUndefined();
        expect(await attempt).toEqual({
          value: { success: true, added: [], removed: [] },
        });
        const membership = await db.query.organization_memberships.findFirst({
          where: and(
            eq(organization_memberships.organization_id, child.id),
            eq(organization_memberships.kilo_user_id, memberUser.id)
          ),
        });
        expect(membership?.role).toBe('admin');
      } finally {
        allowPolicyUpdate.resolve();
        await competingAddition;
        await attempt;
        await cleanupChildOrganizations([child.id]);
      }
    }, 20_000);

    it('serializes overlapping replacements for different members in child ID order', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const firstChild = await createChildOrganization('Concurrent Swap First', childOwner.id);
      const secondChild = await createChildOrganization('Concurrent Swap Second', childOwner.id);
      const [firstId, secondId] = [firstChild.id, secondChild.id].sort();
      await addUserToOrganization(firstId, memberUser.id, 'member');
      await addUserToOrganization(secondId, orgAdminUser.id, 'member');
      const caller = await createCallerForUser(billingManagerUser.id);
      const policyLockHeld = Promise.withResolvers<number>();
      const releasePolicyLock = Promise.withResolvers<void>();
      const policyLock = db.transaction(async tx => {
        await lockOrganizationGroupPolicy(tx, firstId);
        const result = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
        const pid = result.rows[0]?.pid;
        if (pid === undefined) throw new Error('PostgreSQL backend pid unavailable');
        policyLockHeld.resolve(pid);
        await releasePolicyLock.promise;
      });
      const holderPid = await policyLockHeld.promise;
      const attempts = [
        caller.organizations.members.setChildMemberships({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
          childOrganizationIds: [secondId],
        }),
        caller.organizations.members.setChildMemberships({
          organizationId: testOrganization.id,
          memberId: orgAdminUser.id,
          childOrganizationIds: [firstId],
        }),
      ];
      const results = Promise.allSettled(attempts);

      try {
        let waiters = 0;
        for (let i = 0; i < 2000 && waiters < 2; i += 1) {
          const waiting = await db.execute<{ count: number }>(sql`
            SELECT count(*)::int AS count FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND ${holderPid} = ANY(pg_blocking_pids(pid))
          `);
          waiters = waiting.rows[0]?.count ?? 0;
          if (waiters < 2) await new Promise<void>(resolve => setImmediate(resolve));
        }
        expect(waiters).toBe(2);
        releasePolicyLock.resolve();
        await policyLock;
        expect(await results).toEqual([
          { status: 'fulfilled', value: { success: true, added: [secondId], removed: [firstId] } },
          { status: 'fulfilled', value: { success: true, added: [firstId], removed: [secondId] } },
        ]);
        const memberships = await db
          .select({
            organizationId: organization_memberships.organization_id,
            userId: organization_memberships.kilo_user_id,
            role: organization_memberships.role,
          })
          .from(organization_memberships)
          .where(
            and(
              inArray(organization_memberships.organization_id, [firstId, secondId]),
              inArray(organization_memberships.kilo_user_id, [memberUser.id, orgAdminUser.id])
            )
          );
        expect(memberships).toEqual(
          expect.arrayContaining([
            { organizationId: secondId, userId: memberUser.id, role: 'member' },
            { organizationId: firstId, userId: orgAdminUser.id, role: 'member' },
          ])
        );
        expect(memberships).toHaveLength(2);
      } finally {
        releasePolicyLock.resolve();
        await policyLock;
        await results;
        await cleanupChildOrganizations([firstId, secondId]);
      }
    }, 20_000);

    it('serializes an opposite swap and a concurrent child invitation without deadlock', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const firstChild = await createChildOrganization('Invite Swap First', childOwner.id);
      const secondChild = await createChildOrganization('Invite Swap Second', childOwner.id);
      const [firstId, secondId] = [firstChild.id, secondChild.id].sort();
      await addUserToOrganization(secondId, memberUser.id, 'member');
      await db
        .delete(organization_group_policy_settings)
        .where(eq(organization_group_policy_settings.organization_id, secondId));
      const caller = await createCallerForUser(billingManagerUser.id);
      const organizationLockHeld = Promise.withResolvers<number>();
      const allowInvitation = Promise.withResolvers<void>();
      const invitation = db.transaction(async tx => {
        await tx
          .select({ id: organizations.id })
          .from(organizations)
          .where(eq(organizations.id, secondId))
          .for('update');
        const result = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid()::int AS pid`);
        const pid = result.rows[0]?.pid;
        if (pid === undefined) throw new Error('PostgreSQL backend pid unavailable');
        organizationLockHeld.resolve(pid);
        await allowInvitation.promise;
        await tx
          .select({ id: organization_memberships.id })
          .from(organization_memberships)
          .where(
            and(
              eq(organization_memberships.organization_id, testOrganization.id),
              eq(organization_memberships.kilo_user_id, memberUser.id)
            )
          )
          .for('share');
        await tx.insert(organization_invitations).values({
          organization_id: secondId,
          email: `${crypto.randomUUID()}@child-invitation-lock.example.com`,
          role: 'member',
          invited_by: childOwner.id,
          token: crypto.randomUUID(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        });
      });
      const holderPid = await organizationLockHeld.promise;
      const attempt = caller.organizations.members
        .setChildMemberships({
          organizationId: testOrganization.id,
          memberId: memberUser.id,
          childOrganizationIds: [firstId],
        })
        .then(
          value => ({ value }),
          (error: unknown) => ({ error })
        );

      try {
        let blocked = false;
        for (let i = 0; i < 2000 && !blocked; i += 1) {
          const waiting = await db.execute<{ query: string }>(sql`
            SELECT query FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND ${holderPid} = ANY(pg_blocking_pids(pid))
          `);
          blocked = waiting.rows.some(row =>
            /insert into "organization_group_policy_settings"/i.test(row.query)
          );
          if (!blocked) await new Promise<void>(resolve => setImmediate(resolve));
        }
        expect(blocked).toBe(true);
        allowInvitation.resolve();
        await expect(invitation).resolves.toBeUndefined();
        expect(await attempt).toEqual({
          value: { success: true, added: [firstId], removed: [secondId] },
        });
      } finally {
        allowInvitation.resolve();
        await invitation;
        await attempt;
        await db
          .delete(organization_invitations)
          .where(eq(organization_invitations.organization_id, secondId));
        await cleanupChildOrganizations([firstId, secondId]);
      }
    }, 20_000);

    it('rolls back membership and audit changes when a later addition fails', async () => {
      const childOwner = await insertTestUser({ is_admin: false });
      const firstChild = await createChildOrganization('Rollback First Child', childOwner.id);
      const secondChild = await createChildOrganization('Rollback Second Child', childOwner.id);
      const [existingChildId, newChildId] = [firstChild.id, secondChild.id].sort();
      const childIds = [existingChildId, newChildId];
      await addUserToOrganization(existingChildId, memberUser.id, 'member');
      const caller = await createCallerForUser(billingManagerUser.id);
      const createAudit = jest.mocked(createAuditLog);
      const actual = jest.requireActual<typeof OrganizationAuditLogsModule>(
        '@kilocode/web-shared/lib/organizations/organization-audit-logs'
      );
      jest.mocked(invalidateOrganizationSessionAccess).mockClear();
      createAudit.mockClear();
      createAudit.mockImplementationOnce(actual.createAuditLog);
      createAudit.mockRejectedValueOnce(new Error('Audit write failed'));

      try {
        await expect(
          caller.organizations.members.setChildMemberships({
            organizationId: testOrganization.id,
            memberId: memberUser.id,
            childOrganizationIds: [newChildId],
          })
        ).rejects.toThrow('Audit write failed');
        expect(createAudit).toHaveBeenCalledTimes(2);

        const rows = await db
          .select({
            organizationId: organization_memberships.organization_id,
            role: organization_memberships.role,
          })
          .from(organization_memberships)
          .where(
            and(
              eq(organization_memberships.kilo_user_id, memberUser.id),
              inArray(organization_memberships.organization_id, childIds)
            )
          );
        expect(rows).toEqual([{ organizationId: existingChildId, role: 'member' }]);
        const audits = await db
          .select()
          .from(organization_audit_logs)
          .where(inArray(organization_audit_logs.organization_id, childIds));
        expect(audits).toEqual([]);
        const removals = await db
          .select()
          .from(organization_membership_removals)
          .where(inArray(organization_membership_removals.organization_id, childIds));
        expect(removals).toEqual([]);
        expect(invalidateOrganizationSessionAccess).not.toHaveBeenCalled();
      } finally {
        createAudit.mockReset();
        createAudit.mockImplementation(actual.createAuditLog);
        await cleanupChildOrganizations(childIds);
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

    it('refuses an address past the 254-character maximum and creates no invitation', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // A 64-character local part then three 63-character labels: 254 characters
      // is the longest address a mail system delivers.
      const longest = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(61)}`;
      const oneMore = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(62)}`;
      expect(longest).toHaveLength(254);
      expect(oneMore).toHaveLength(255);

      const accepted = await caller.organizations.members.invite({
        organizationId: testOrganization.id,
        email: longest,
        role: 'member',
      });
      expect(accepted).toHaveProperty('invitationId');

      await expect(
        caller.organizations.members.invite({
          organizationId: testOrganization.id,
          email: oneMore,
          role: 'member',
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('Email address must be 254 characters or fewer'),
      });

      const overLengthInvitations = await db
        .select()
        .from(organization_invitations)
        .where(
          and(
            eq(organization_invitations.organization_id, testOrganization.id),
            eq(organization_invitations.email, oneMore)
          )
        );
      expect(overLengthInvitations).toHaveLength(0);

      const queuedForOverLength = await db
        .select()
        .from(external_side_effect_outbox)
        .where(sql`${external_side_effect_outbox.payload}->>'to' = ${oneMore}`);
      expect(queuedForOverLength).toHaveLength(0);
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

    it('should reject inviting someone who is not a parent organization member', async () => {
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
      ).rejects.toThrow(
        'Child organizations can only invite people who are already members of the parent organization.'
      );
    });

    it('should invite a parent organization member into a child organization', async () => {
      const childOrg = await createOrganization(
        'Child Members Invite Organization',
        regularUser.id
      );
      await db
        .update(organizations)
        .set({ parent_organization_id: testOrganization.id })
        .where(eq(organizations.id, childOrg.id));

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.organizations.members.invite({
        organizationId: childOrg.id,
        email: memberUser.google_user_email,
        role: 'member',
      });

      expect(result).toHaveProperty('acceptInviteUrl');
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
      const { db } = await import('@kilocode/web-shared/lib/drizzle');
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
      const { db } = await import('@kilocode/web-shared/lib/drizzle');
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
      const { db } = await import('@kilocode/web-shared/lib/drizzle');
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

      const { db } = await import('@kilocode/web-shared/lib/drizzle');
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

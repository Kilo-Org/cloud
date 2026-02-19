import { createCallerForUser } from '@/routers/test-utils';
import { db } from '@/lib/drizzle';
import { organizations } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization, addUserToOrganization } from '@/lib/organizations/organizations';
import type { User, Organization } from '@/db/schema';

// Test users and organization will be created dynamically
let regularUser: User;
let adminUser: User;
let memberUser: User;
let nonMemberUser: User;
let testOrganization: Organization;

describe('organizations trpc router', () => {
  beforeAll(async () => {
    // Create test users using the helper function
    regularUser = await insertTestUser({
      google_user_email: 'regular-org@example.com',
      google_user_name: 'Regular Org User',
      is_admin: false,
    });

    adminUser = await insertTestUser({
      google_user_email: 'admin-org@admin.example.com',
      google_user_name: 'Admin Org User',
      is_admin: true,
    });

    memberUser = await insertTestUser({
      google_user_email: 'member-org@example.com',
      google_user_name: 'Member Org User',
      is_admin: false,
    });

    nonMemberUser = await insertTestUser({
      google_user_email: 'non-member-org@example.com',
      google_user_name: 'Non Member Org User',
      is_admin: false,
    });

    // Create test organization using the CRUD method
    testOrganization = await createOrganization('Test Organization', regularUser.id);

    // Set organization balance using direct DB update (since there's no CRUD method for this)
    await db
      .update(organizations)
      .set({
        total_microdollars_acquired: 1000000, // $1.00 in microdollars
        stripe_customer_id: 'cus_test_org',
      })
      .where(eq(organizations.id, testOrganization.id));

    // Add member user to organization using CRUD method
    await addUserToOrganization(testOrganization.id, memberUser.id, 'member');
  });

  afterAll(async () => {
    // Clean up test data - organizations cleanup will cascade to memberships
    await db.delete(organizations).where(eq(organizations.id, testOrganization.id));
  });

  describe('get procedure', () => {
    it('should return organization with members for organization owner', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.organizations.withMembers({
        organizationId: testOrganization.id,
      });

      expect(result).toMatchObject({
        id: testOrganization.id,
        name: 'Test Organization',
        total_microdollars_acquired: 1000000,
        microdollars_used: 0,
        stripe_customer_id: 'cus_test_org',
        auto_top_up_enabled: false,
        settings: {},
        members: expect.arrayContaining([
          expect.objectContaining({
            id: regularUser.id,
            name: 'Regular Org User',
            email: 'regular-org@example.com',
            role: 'owner',
            status: 'active',
          }),
          expect.objectContaining({
            id: memberUser.id,
            name: 'Member Org User',
            email: 'member-org@example.com',
            role: 'member',
            status: 'active',
          }),
        ]),
      });
      expect(result.members).toHaveLength(2);
    });

    it('should return organization with members for organization member', async () => {
      const caller = await createCallerForUser(memberUser.id);
      const result = await caller.organizations.withMembers({
        organizationId: testOrganization.id,
      });

      expect(result).toMatchObject({
        id: testOrganization.id,
        name: 'Test Organization',
        members: expect.arrayContaining([
          expect.objectContaining({
            id: regularUser.id,
            role: 'owner',
            status: 'active',
          }),
          expect.objectContaining({
            id: memberUser.id,
            role: 'member',
            status: 'active',
          }),
        ]),
      });
    });

    it('should return organization for admin user even if not a member', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const result = await caller.organizations.withMembers({
        organizationId: testOrganization.id,
      });

      expect(result).toMatchObject({
        id: testOrganization.id,
        name: 'Test Organization',
        members: expect.arrayContaining([
          expect.objectContaining({
            id: regularUser.id,
            role: 'owner',
            status: 'active',
          }),
          expect.objectContaining({
            id: memberUser.id,
            role: 'member',
            status: 'active',
          }),
        ]),
      });
    });

    it('should throw UNAUTHORIZED error for non-member users', async () => {
      const caller = await createCallerForUser(nonMemberUser.id);

      await expect(
        caller.organizations.withMembers({ organizationId: testOrganization.id })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should throw UNAUTHORIZED error for non-existent organization', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const nonExistentOrgId = '550e8400-e29b-41d4-a716-446655440001'; // Valid UUID but non-existent

      await expect(
        caller.organizations.withMembers({ organizationId: nonExistentOrgId })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should validate organizationId input format', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Test with invalid UUID format
      await expect(
        caller.organizations.withMembers({ organizationId: 'invalid-uuid' })
      ).rejects.toThrow();
    });

    it('should include member details with correct structure', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.organizations.withMembers({
        organizationId: testOrganization.id,
      });

      // Check that each member has the expected structure
      result.members.forEach(member => {
        if (member.status === 'active') {
          expect(member).toHaveProperty('id');
          expect(member).toHaveProperty('name');
          expect(member).toHaveProperty('email');
          expect(member).toHaveProperty('role');
          expect(member).toHaveProperty('status', 'active');
          expect(member).toHaveProperty('inviteDate');
          expect(member).toHaveProperty('dailyUsageLimitUsd');
          expect(member).toHaveProperty('currentDailyUsageUsd');
        } else if (member.status === 'invited') {
          expect(member).toHaveProperty('email');
          expect(member).toHaveProperty('role');
          expect(member).toHaveProperty('status', 'invited');
          expect(member).toHaveProperty('inviteDate');
          expect(member).toHaveProperty('inviteToken');
          expect(member).toHaveProperty('inviteId');
          expect(member).toHaveProperty('inviteUrl');
          expect(member).toHaveProperty('dailyUsageLimitUsd');
          expect(member).toHaveProperty('currentDailyUsageUsd');
        }
      });
    });
  });

  describe('update procedure', () => {
    it('should update organization name for organization owner', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const newName = 'Updated Test Organization';

      const result = await caller.organizations.update({
        organizationId: testOrganization.id,
        name: newName,
      });

      expect(result).toEqual({
        organization: {
          id: testOrganization.id,
          name: newName,
        },
      });

      // Verify the organization was actually updated in the database
      const updatedOrg = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      expect(updatedOrg[0].name).toBe(newName);

      // Reset the name for other tests
      await db
        .update(organizations)
        .set({ name: 'Test Organization' })
        .where(eq(organizations.id, testOrganization.id));
    });

    it('should update organization name for admin user even if not owner', async () => {
      const caller = await createCallerForUser(adminUser.id);
      const newName = 'Admin Updated Organization';

      const result = await caller.organizations.update({
        organizationId: testOrganization.id,
        name: newName,
      });

      expect(result).toEqual({
        organization: {
          id: testOrganization.id,
          name: newName,
        },
      });

      // Verify the organization was actually updated in the database
      const updatedOrg = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      expect(updatedOrg[0].name).toBe(newName);

      // Reset the name for other tests
      await db
        .update(organizations)
        .set({ name: 'Test Organization' })
        .where(eq(organizations.id, testOrganization.id));
    });

    it('should throw UNAUTHORIZED error for organization member (non-owner)', async () => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.update({
          organizationId: testOrganization.id,
          name: 'Should Not Update',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should throw UNAUTHORIZED error for non-member users', async () => {
      const caller = await createCallerForUser(nonMemberUser.id);

      await expect(
        caller.organizations.update({
          organizationId: testOrganization.id,
          name: 'Should Not Update',
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should throw UNAUTHORIZED error for non-existent organization', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const nonExistentOrgId = '550e8400-e29b-41d4-a716-446655440002'; // Valid UUID but non-existent

      await expect(
        caller.organizations.update({
          organizationId: nonExistentOrgId,
          name: 'Should Not Update',
        })
      ).rejects.toThrow('You do not have access to this organization');
    });

    it('should validate organizationId input format', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Test with invalid UUID format
      await expect(
        caller.organizations.update({
          organizationId: 'invalid-uuid',
          name: 'Valid Name',
        })
      ).rejects.toThrow();
    });

    it('should validate organization name input', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Test with empty name
      await expect(
        caller.organizations.update({
          organizationId: testOrganization.id,
          name: '',
        })
      ).rejects.toThrow('Organization name is required');

      // Test with whitespace-only name
      await expect(
        caller.organizations.update({
          organizationId: testOrganization.id,
          name: '   ',
        })
      ).rejects.toThrow('Organization name is required');

      // Test with name that's too long (over 100 characters)
      const longName = 'a'.repeat(101);
      await expect(
        caller.organizations.update({
          organizationId: testOrganization.id,
          name: longName,
        })
      ).rejects.toThrow('Organization name must be less than 100 characters');
    });

    it('should trim whitespace from organization name', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const nameWithWhitespace = '  Trimmed Organization Name  ';
      const expectedName = 'Trimmed Organization Name';

      const result = await caller.organizations.update({
        organizationId: testOrganization.id,
        name: nameWithWhitespace,
      });

      expect(result).toEqual({
        organization: {
          id: testOrganization.id,
          name: expectedName,
        },
      });

      // Verify the organization was updated with trimmed name in the database
      const updatedOrg = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      expect(updatedOrg[0].name).toBe(expectedName);

      // Reset the name for other tests
      await db
        .update(organizations)
        .set({ name: 'Test Organization' })
        .where(eq(organizations.id, testOrganization.id));
    });

    it('should handle valid edge case names', async () => {
      const caller = await createCallerForUser(regularUser.id);

      // Test with minimum length name (1 character)
      const minName = 'A';
      let result = await caller.organizations.update({
        organizationId: testOrganization.id,
        name: minName,
      });
      expect(result.organization.name).toBe(minName);

      // Test with maximum length name (100 characters)
      const maxName = 'a'.repeat(100);
      result = await caller.organizations.update({
        organizationId: testOrganization.id,
        name: maxName,
      });
      expect(result.organization.name).toBe(maxName);

      // Reset the name for other tests
      await db
        .update(organizations)
        .set({ name: 'Test Organization' })
        .where(eq(organizations.id, testOrganization.id));
    });
  });

  describe('createOrganization with company_domain', () => {
    let createdOrgId: string | undefined;

    afterEach(async () => {
      if (createdOrgId) {
        await db.delete(organizations).where(eq(organizations.id, createdOrgId));
        createdOrgId = undefined;
      }
    });

    it('should store company_domain when provided', async () => {
      const org = await createOrganization('Domain Org', regularUser.id, true, 'acme.com');
      createdOrgId = org.id;

      const [row] = await db.select().from(organizations).where(eq(organizations.id, org.id));

      expect(row.company_domain).toBe('acme.com');
    });

    it('should default company_domain to null when omitted', async () => {
      const org = await createOrganization('No Domain Org', regularUser.id, true);
      createdOrgId = org.id;

      const [row] = await db.select().from(organizations).where(eq(organizations.id, org.id));

      expect(row.company_domain).toBeNull();
    });
  });

  describe('updateCompanyDomain procedure', () => {
    it('should set company_domain for organization owner', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.organizations.updateCompanyDomain({
        organizationId: testOrganization.id,
        company_domain: 'example.com',
      });

      expect(result).toEqual({ success: true });

      const [row] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      expect(row.company_domain).toBe('example.com');
    });

    it('should normalize a URL to just the domain', async () => {
      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.organizations.updateCompanyDomain({
        organizationId: testOrganization.id,
        company_domain: 'https://acme.com/about',
      });

      expect(result).toEqual({ success: true });

      const [row] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      expect(row.company_domain).toBe('acme.com');
    });

    it('should pass through a bare domain unchanged', async () => {
      const caller = await createCallerForUser(regularUser.id);
      await caller.organizations.updateCompanyDomain({
        organizationId: testOrganization.id,
        company_domain: 'my-company.co.uk',
      });

      const [row] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      expect(row.company_domain).toBe('my-company.co.uk');
    });

    it('should reject an invalid domain format', async () => {
      const caller = await createCallerForUser(regularUser.id);

      await expect(
        caller.organizations.updateCompanyDomain({
          organizationId: testOrganization.id,
          company_domain: 'not-a-domain',
        })
      ).rejects.toThrow();
    });

    it('should clear company_domain with null', async () => {
      // First set a domain
      await db
        .update(organizations)
        .set({ company_domain: 'to-be-cleared.com' })
        .where(eq(organizations.id, testOrganization.id));

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.organizations.updateCompanyDomain({
        organizationId: testOrganization.id,
        company_domain: null,
      });

      expect(result).toEqual({ success: true });

      const [row] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      expect(row.company_domain).toBeNull();
    });

    it('should clear company_domain with empty string', async () => {
      await db
        .update(organizations)
        .set({ company_domain: 'to-be-cleared.com' })
        .where(eq(organizations.id, testOrganization.id));

      const caller = await createCallerForUser(regularUser.id);
      const result = await caller.organizations.updateCompanyDomain({
        organizationId: testOrganization.id,
        company_domain: '',
      });

      expect(result).toEqual({ success: true });

      const [row] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, testOrganization.id));

      expect(row.company_domain).toBeNull();
    });

    it('should reject non-owner members', async () => {
      const caller = await createCallerForUser(memberUser.id);

      await expect(
        caller.organizations.updateCompanyDomain({
          organizationId: testOrganization.id,
          company_domain: 'hacker.com',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('should reject non-members', async () => {
      const caller = await createCallerForUser(nonMemberUser.id);

      await expect(
        caller.organizations.updateCompanyDomain({
          organizationId: testOrganization.id,
          company_domain: 'hacker.com',
        })
      ).rejects.toThrow('You do not have access to this organization');
    });
  });
});

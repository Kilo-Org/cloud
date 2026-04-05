import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { addUserToOrganization } from '@/lib/organizations/organizations';
import { getAllOrganizationModes } from '@/lib/organizations/organization-modes';
import type { User, Organization } from '@kilocode/db/schema';
import { randomUUID } from 'crypto';

let owner: User;
let member: User;
let testOrganization: Organization;

describe('organization modes tRPC router', () => {
  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: 'owner-modes@example.com',
      google_user_name: 'Owner Modes User',
      is_admin: false,
    });

    member = await insertTestUser({
      google_user_email: 'member-modes@example.com',
      google_user_name: 'Member Modes User',
      is_admin: false,
    });

    testOrganization = await createTestOrganization('Test Org for Modes', owner.id, 0, {}, false);
    await addUserToOrganization(testOrganization.id, member.id, 'member');
  });

  describe('create procedure', () => {
    it('should create a mode for organization owner', async () => {
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Code Mode',
        slug: 'code',
        config: {
          roleDefinition: 'You are a coding assistant',
          groups: ['read', 'edit'],
        },
      });

      expect(result.mode).toBeDefined();
      expect(result.mode.name).toBe('Code Mode');
      expect(result.mode.slug).toBe('code');
      expect(result.mode.organization_id).toBe(testOrganization.id);
      expect(result.mode.created_by).toBe(owner.id);
      expect(result.mode.config.roleDefinition).toBe('You are a coding assistant');
      expect(result.mode.config.groups).toEqual(['read', 'edit']);
    });

    it('should create a mode with minimal config', async () => {
      const caller = await createCallerForUser(owner.id);

      const result = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Simple Mode',
        slug: 'simple',
      });

      expect(result.mode).toBeDefined();
      expect(result.mode.name).toBe('Simple Mode');
      expect(result.mode.slug).toBe('simple');
      expect(result.mode.config.roleDefinition).toBe('default');
      expect(result.mode.config.groups).toEqual([]);
    });

    it('should allow members to create modes', async () => {
      const caller = await createCallerForUser(member.id);

      const result = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Member Mode',
        slug: 'member-mode',
      });

      expect(result.mode).toBeDefined();
      expect(result.mode.name).toBe('Member Mode');
      expect(result.mode.slug).toBe('member-mode');
      expect(result.mode.created_by).toBe(member.id);
    });

    it('should throw error for duplicate slug', async () => {
      const caller = await createCallerForUser(owner.id);

      // Create first mode
      await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'First Mode',
        slug: 'duplicate-slug',
      });

      // Try to create second mode with same slug
      await expect(
        caller.organizations.modes.create({
          organizationId: testOrganization.id,
          name: 'Second Mode',
          slug: 'duplicate-slug',
        })
      ).rejects.toThrow();
    });

    it('should validate slug format', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.modes.create({
          organizationId: testOrganization.id,
          name: 'Invalid Slug Mode',
          slug: 'Invalid Slug!',
        })
      ).rejects.toThrow();
    });

    it('should throw error for non-existent organization', async () => {
      const caller = await createCallerForUser(owner.id);
      const nonExistentId = randomUUID();

      await expect(
        caller.organizations.modes.create({
          organizationId: nonExistentId,
          name: 'Test Mode',
          slug: 'test',
        })
      ).rejects.toThrow();
    });
  });

  describe('list procedure', () => {
    it('should list all modes for an organization', async () => {
      const caller = await createCallerForUser(owner.id);

      // Create a fresh organization for this test
      const freshOrg = await createTestOrganization('List Test Org', owner.id, 0, {}, false);

      // Create multiple modes
      await caller.organizations.modes.create({
        organizationId: freshOrg.id,
        name: 'Mode 1',
        slug: 'mode-1',
      });

      await caller.organizations.modes.create({
        organizationId: freshOrg.id,
        name: 'Mode 2',
        slug: 'mode-2',
      });

      const result = await caller.organizations.modes.list({
        organizationId: freshOrg.id,
      });

      expect(result.modes).toHaveLength(2);
      expect(result.modes.map(m => m.slug).sort()).toEqual(['mode-1', 'mode-2']);
    });

    it('should return empty array for organization with no modes', async () => {
      const caller = await createCallerForUser(owner.id);
      const emptyOrg = await createTestOrganization('Empty Org', owner.id, 0, {}, false);

      const result = await caller.organizations.modes.list({
        organizationId: emptyOrg.id,
      });

      expect(result.modes).toEqual([]);
    });

    it('should allow members to list modes', async () => {
      const caller = await createCallerForUser(member.id);

      const result = await caller.organizations.modes.list({
        organizationId: testOrganization.id,
      });

      expect(result.modes).toBeDefined();
      expect(Array.isArray(result.modes)).toBe(true);
    });
  });

  describe('getById procedure', () => {
    it('should get a mode by id', async () => {
      const caller = await createCallerForUser(owner.id);

      // Create a mode
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Get By ID Mode',
        slug: 'get-by-id',
        config: {
          roleDefinition: 'Test role',
          description: 'Test description',
        },
      });

      const result = await caller.organizations.modes.getById({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
      });

      expect(result.mode).toBeDefined();
      expect(result.mode.id).toBe(created.mode.id);
      expect(result.mode.name).toBe('Get By ID Mode');
      expect(result.mode.config.description).toBe('Test description');
    });

    it('should throw error for non-existent mode', async () => {
      const caller = await createCallerForUser(owner.id);
      const nonExistentId = randomUUID();

      await expect(
        caller.organizations.modes.getById({
          organizationId: testOrganization.id,
          modeId: nonExistentId,
        })
      ).rejects.toThrow();
    });

    it('should allow members to get modes', async () => {
      const caller = await createCallerForUser(owner.id);

      // Create a mode
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Member Access Mode',
        slug: 'member-access',
      });

      const memberCaller = await createCallerForUser(member.id);
      const result = await memberCaller.organizations.modes.getById({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
      });

      expect(result.mode).toBeDefined();
      expect(result.mode.id).toBe(created.mode.id);
    });
  });

  describe('update procedure', () => {
    it('should update mode name and slug', async () => {
      const caller = await createCallerForUser(owner.id);

      // Create a mode
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Original Name',
        slug: 'original-slug',
      });

      const result = await caller.organizations.modes.update({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
        name: 'Updated Name',
        slug: 'updated-slug',
      });

      expect(result.mode.name).toBe('Updated Name');
      expect(result.mode.slug).toBe('updated-slug');
    });

    it('should update mode config', async () => {
      const caller = await createCallerForUser(owner.id);

      // Create a mode
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Config Update Mode',
        slug: 'config-update',
        config: {
          roleDefinition: 'Original role',
          groups: ['read'],
        },
      });

      const result = await caller.organizations.modes.update({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
        config: {
          roleDefinition: 'Updated role',
          description: 'New description',
          groups: ['read', 'edit', 'browser'],
        },
      });

      expect(result.mode.config.roleDefinition).toBe('Updated role');
      expect(result.mode.config.description).toBe('New description');
      expect(result.mode.config.groups).toEqual(['read', 'edit', 'browser']);
    });

    it('should allow members to update modes', async () => {
      const caller = await createCallerForUser(owner.id);

      // Create a mode
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Update Test Mode',
        slug: 'update-test',
      });

      const memberCaller = await createCallerForUser(member.id);

      const result = await memberCaller.organizations.modes.update({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
        name: 'Member Update',
      });

      expect(result.mode.name).toBe('Member Update');
    });

    it('should throw error for non-existent mode', async () => {
      const caller = await createCallerForUser(owner.id);
      const nonExistentId = randomUUID();

      await expect(
        caller.organizations.modes.update({
          organizationId: testOrganization.id,
          modeId: nonExistentId,
          name: 'Updated Name',
        })
      ).rejects.toThrow();
    });

    it('should throw error when updating to duplicate slug', async () => {
      const caller = await createCallerForUser(owner.id);

      // Create two modes
      await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Mode A',
        slug: 'slug-a',
      });

      const modeB = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Mode B',
        slug: 'slug-b',
      });

      // Try to update Mode B to use slug-a
      await expect(
        caller.organizations.modes.update({
          organizationId: testOrganization.id,
          modeId: modeB.mode.id,
          slug: 'slug-a',
        })
      ).rejects.toThrow();
    });
  });

  describe('delete procedure', () => {
    it('should delete a mode', async () => {
      const caller = await createCallerForUser(owner.id);

      // Create a mode
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'To Be Deleted',
        slug: 'to-be-deleted',
      });

      const result = await caller.organizations.modes.delete({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
      });

      expect(result.success).toBe(true);

      // Verify it's actually deleted
      const modes = await getAllOrganizationModes(testOrganization.id);
      expect(modes.find(m => m.id === created.mode.id)).toBeUndefined();
    });

    it('should allow members to delete modes', async () => {
      const caller = await createCallerForUser(owner.id);

      // Create a mode
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Delete Test Mode',
        slug: 'delete-test',
      });

      const memberCaller = await createCallerForUser(member.id);

      const result = await memberCaller.organizations.modes.delete({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
      });

      expect(result.success).toBe(true);
    });

    it('should throw error for non-existent mode', async () => {
      const caller = await createCallerForUser(owner.id);
      const nonExistentId = randomUUID();

      await expect(
        caller.organizations.modes.delete({
          organizationId: testOrganization.id,
          modeId: nonExistentId,
        })
      ).rejects.toThrow();
    });
  });
});

import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { addUserToOrganization, getOrganizationById } from '@/lib/organizations/organizations';
import { getAllOrganizationModes } from '@/lib/organizations/organization-modes';
import type { User, Organization } from '@kilocode/db/schema';
import { organization_audit_logs } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { desc, eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

jest.mock('@/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: jest.fn(async () => true),
}));

const mockedIsReleaseToggleEnabled = jest.mocked(
  jest.requireMock('@/lib/posthog-feature-flags').isReleaseToggleEnabled
);

let owner: User;
let member: User;
let billingManager: User;
let testOrganization: Organization;

describe('organization modes tRPC router', () => {
  beforeEach(() => {
    mockedIsReleaseToggleEnabled.mockResolvedValue(true);
  });

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

    billingManager = await insertTestUser({
      google_user_email: 'billing-modes@example.com',
      google_user_name: 'Billing Modes User',
      is_admin: false,
    });

    testOrganization = await createTestOrganization('Test Org for Modes', owner.id, 0, {}, false);
    await addUserToOrganization(testOrganization.id, member.id, 'member');
    await addUserToOrganization(testOrganization.id, billingManager.id, 'billing_manager');
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

    it('does not clear a canonical route when create omits route_model', async () => {
      const caller = await createCallerForUser(owner.id);
      const freshOrg = await createTestOrganization('Create Route Org', owner.id, 0, {}, false);
      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: freshOrg.id,
        mode_slug: 'create-route-mode',
        model_id: 'kilo-auto/frontier',
      });

      const result = await caller.organizations.modes.create({
        organizationId: freshOrg.id,
        name: 'Create Route Mode',
        slug: 'create-route-mode',
      });

      expect(result.mode.config).not.toHaveProperty('defaultModel');
    });

    it('records route details in mode create audit messages', async () => {
      const caller = await createCallerForUser(owner.id);
      const result = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Routed Mode',
        slug: 'routed-mode',
        route_model: 'kilo-auto/frontier',
      });

      const [audit] = await db
        .select()
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, testOrganization.id))
        .orderBy(desc(organization_audit_logs.created_at));

      expect(result.mode.slug).toBe('routed-mode');
      expect(audit?.message).toContain('Organization Auto route set');
      expect(audit?.message).toContain('routed-mode');
    });

    it('stores route_model in canonical Organization Auto routes', async () => {
      const caller = await createCallerForUser(owner.id);
      const freshOrg = await createTestOrganization(
        'Create With Route Org',
        owner.id,
        0,
        {},
        false
      );

      const result = await caller.organizations.modes.create({
        organizationId: freshOrg.id,
        name: 'Create With Route Mode',
        slug: 'create-with-route-mode',
        route_model: 'kilo-auto/balanced',
      });

      expect(result.mode.config).not.toHaveProperty('defaultModel');
      const updatedOrganization = await getOrganizationById(freshOrg.id);
      expect(updatedOrganization?.settings.org_auto_model?.routes['create-with-route-mode']).toBe(
        'kilo-auto/balanced'
      );
    });

    it('rejects route_model from billing managers', async () => {
      const caller = await createCallerForUser(billingManager.id);

      await expect(
        caller.organizations.modes.create({
          organizationId: testOrganization.id,
          name: 'Billing Routed Mode',
          slug: 'billing-routed-mode',
          route_model: 'kilo-auto/balanced',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');
    });

    it('records a clear message when create explicitly clears an existing route', async () => {
      const caller = await createCallerForUser(owner.id);
      const freshOrg = await createTestOrganization(
        'Create Clear Route Org',
        owner.id,
        0,
        {},
        false
      );
      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: freshOrg.id,
        mode_slug: 'create-clear-route-mode',
        model_id: 'kilo-auto/frontier',
      });

      await caller.organizations.modes.create({
        organizationId: freshOrg.id,
        name: 'Create Clear Route Mode',
        slug: 'create-clear-route-mode',
        route_model: null,
      });

      const updatedOrganization = await getOrganizationById(freshOrg.id);
      expect(updatedOrganization?.settings.org_auto_model?.routes['create-clear-route-mode']).toBe(
        undefined
      );

      const [audit] = await db
        .select()
        .from(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, freshOrg.id))
        .orderBy(desc(organization_audit_logs.created_at));

      expect(audit?.message).toContain('Organization Auto route cleared');
      expect(audit?.message).toContain('create-clear-route-mode');
    });

    it('rejects route_model for non-enterprise organizations', async () => {
      const caller = await createCallerForUser(owner.id);
      const teamsOrg = await createTestOrganization('Teams Route Org', owner.id, 0, {}, true);

      await expect(
        caller.organizations.modes.create({
          organizationId: teamsOrg.id,
          name: 'Teams Route Mode',
          slug: 'teams-route-mode',
          route_model: 'kilo-auto/balanced',
        })
      ).rejects.toThrow('Organization Auto is only available for Enterprise organizations.');
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

    it('does not project canonical Organization Auto routes into mode responses', async () => {
      const caller = await createCallerForUser(owner.id);
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Projected Mode',
        slug: 'projected-mode',
      });
      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: testOrganization.id,
        mode_slug: 'projected-mode',
        model_id: 'kilo-auto/frontier',
      });

      const result = await caller.organizations.modes.getById({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
      });
      const listed = await caller.organizations.modes.list({
        organizationId: testOrganization.id,
      });

      expect(result.mode.config).not.toHaveProperty('defaultModel');
      expect(listed.modes.find(mode => mode.id === created.mode.id)?.config).not.toHaveProperty(
        'defaultModel'
      );
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

    it('stores update route_model in canonical Organization Auto routes', async () => {
      const caller = await createCallerForUser(owner.id);
      const freshOrg = await createTestOrganization(
        'Update With Route Org',
        owner.id,
        0,
        {},
        false
      );
      const created = await caller.organizations.modes.create({
        organizationId: freshOrg.id,
        name: 'Update With Route Mode',
        slug: 'update-with-route-mode',
      });

      const result = await caller.organizations.modes.update({
        organizationId: freshOrg.id,
        modeId: created.mode.id,
        route_model: 'kilo-auto/frontier',
      });

      expect(result.mode.config).not.toHaveProperty('defaultModel');
      const updatedOrganization = await getOrganizationById(freshOrg.id);
      expect(updatedOrganization?.settings.org_auto_model?.routes['update-with-route-mode']).toBe(
        'kilo-auto/frontier'
      );
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

    it('should allow ordinary mode edits when the release flag is disabled', async () => {
      mockedIsReleaseToggleEnabled.mockResolvedValue(false);
      const caller = await createCallerForUser(owner.id);
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Code Mode',
        slug: 'flag-disabled-normal-update',
        config: {
          roleDefinition: 'You are a coding assistant',
          groups: ['read'],
        },
      });

      await expect(
        caller.organizations.modes.update({
          organizationId: testOrganization.id,
          modeId: created.mode.id,
          config: {
            description: 'Updated description',
          },
        })
      ).resolves.toMatchObject({
        mode: {
          config: {
            description: 'Updated description',
          },
        },
      });
    });

    it('allows owners to rename routed modes when the release flag is disabled', async () => {
      const caller = await createCallerForUser(owner.id);
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Flag Disabled Routed Rename',
        slug: 'flag-disabled-routed-rename',
      });
      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: testOrganization.id,
        mode_slug: 'flag-disabled-routed-rename',
        model_id: 'kilo-auto/balanced',
      });
      mockedIsReleaseToggleEnabled.mockResolvedValue(false);

      await caller.organizations.modes.update({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
        slug: 'flag-disabled-routed-renamed',
      });

      const updatedOrganization = await getOrganizationById(testOrganization.id);
      expect(
        updatedOrganization?.settings.org_auto_model?.routes['flag-disabled-routed-rename']
      ).toBeUndefined();
      expect(
        updatedOrganization?.settings.org_auto_model?.routes['flag-disabled-routed-renamed']
      ).toBe('kilo-auto/balanced');
    });
  });

  it('migrates an Organization Auto route when a custom mode slug changes', async () => {
    const caller = await createCallerForUser(owner.id);
    const created = await caller.organizations.modes.create({
      organizationId: testOrganization.id,
      name: 'Route Mode',
      slug: 'route-mode',
    });
    await caller.organizations.settings.setOrganizationAutoRoute({
      organizationId: testOrganization.id,
      mode_slug: 'route-mode',
      model_id: 'openai/gpt-4o',
    });

    await caller.organizations.modes.update({
      organizationId: testOrganization.id,
      modeId: created.mode.id,
      slug: 'renamed-route-mode',
    });

    const updatedOrganization = await getOrganizationById(testOrganization.id);
    expect(updatedOrganization?.settings.org_auto_model?.routes['route-mode']).toBeUndefined();
    expect(updatedOrganization?.settings.org_auto_model?.routes['renamed-route-mode']).toBe(
      'openai/gpt-4o'
    );
  });

  it('rejects a rename when the destination already has an Organization Auto route', async () => {
    const caller = await createCallerForUser(owner.id);
    const created = await caller.organizations.modes.create({
      organizationId: testOrganization.id,
      name: 'Source Route Mode',
      slug: 'source-route-conflict',
    });
    await caller.organizations.settings.setOrganizationAutoRoute({
      organizationId: testOrganization.id,
      mode_slug: 'source-route-conflict',
      model_id: 'kilo-auto/balanced',
    });
    await caller.organizations.settings.setOrganizationAutoRoute({
      organizationId: testOrganization.id,
      mode_slug: 'destination-route-conflict',
      model_id: 'kilo-auto/frontier',
    });

    await expect(
      caller.organizations.modes.update({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
        slug: 'destination-route-conflict',
      })
    ).rejects.toThrow(
      'Organization Auto route already exists for mode "destination-route-conflict"'
    );

    const updatedOrganization = await getOrganizationById(testOrganization.id);
    expect(updatedOrganization?.settings.org_auto_model?.routes['source-route-conflict']).toBe(
      'kilo-auto/balanced'
    );
    expect(updatedOrganization?.settings.org_auto_model?.routes['destination-route-conflict']).toBe(
      'kilo-auto/frontier'
    );
  });

  it('prevents members from renaming a mode with an Organization Auto route', async () => {
    const caller = await createCallerForUser(owner.id);
    const created = await caller.organizations.modes.create({
      organizationId: testOrganization.id,
      name: 'Routed Rename Mode',
      slug: 'routed-rename-test',
    });
    await caller.organizations.settings.setOrganizationAutoRoute({
      organizationId: testOrganization.id,
      mode_slug: 'routed-rename-test',
      model_id: 'kilo-auto/balanced',
    });

    const memberCaller = await createCallerForUser(member.id);
    await expect(
      memberCaller.organizations.modes.update({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
        slug: 'member-renamed-mode',
      })
    ).rejects.toThrow('You do not have the required organizational role to access this feature');

    const updatedOrganization = await getOrganizationById(testOrganization.id);
    expect(updatedOrganization?.settings.org_auto_model?.routes['routed-rename-test']).toBe(
      'kilo-auto/balanced'
    );
  });

  it('rolls back route migration when a renamed mode collides', async () => {
    const caller = await createCallerForUser(owner.id);
    const routedMode = await caller.organizations.modes.create({
      organizationId: testOrganization.id,
      name: 'Routed Collision Mode',
      slug: 'routed-collision-test',
    });
    await caller.organizations.settings.setOrganizationAutoRoute({
      organizationId: testOrganization.id,
      mode_slug: 'routed-collision-test',
      model_id: 'kilo-auto/balanced',
    });
    await caller.organizations.modes.create({
      organizationId: testOrganization.id,
      name: 'Existing Collision Mode',
      slug: 'existing-collision-test',
    });

    await expect(
      caller.organizations.modes.update({
        organizationId: testOrganization.id,
        modeId: routedMode.mode.id,
        slug: 'existing-collision-test',
      })
    ).rejects.toThrow();

    const updatedOrganization = await getOrganizationById(testOrganization.id);
    expect(updatedOrganization?.settings.org_auto_model?.routes['routed-collision-test']).toBe(
      'kilo-auto/balanced'
    );
    expect(updatedOrganization?.settings.org_auto_model?.routes['existing-collision-test']).toBe(
      undefined
    );
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

    it('removes an Organization Auto route when a custom mode is deleted', async () => {
      const caller = await createCallerForUser(owner.id);
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Delete Route Mode',
        slug: 'delete-route-mode',
      });
      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: testOrganization.id,
        mode_slug: 'delete-route-mode',
        model_id: 'openai/gpt-4o',
      });

      await caller.organizations.modes.delete({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
      });

      const updatedOrganization = await getOrganizationById(testOrganization.id);
      expect(
        updatedOrganization?.settings.org_auto_model?.routes['delete-route-mode']
      ).toBeUndefined();
    });

    it('allows owners to delete routed modes when the release flag is disabled', async () => {
      const caller = await createCallerForUser(owner.id);
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Flag Disabled Routed Delete',
        slug: 'flag-disabled-routed-delete',
      });
      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: testOrganization.id,
        mode_slug: 'flag-disabled-routed-delete',
        model_id: 'kilo-auto/balanced',
      });
      mockedIsReleaseToggleEnabled.mockResolvedValue(false);

      await caller.organizations.modes.delete({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
      });

      const updatedOrganization = await getOrganizationById(testOrganization.id);
      expect(
        updatedOrganization?.settings.org_auto_model?.routes['flag-disabled-routed-delete']
      ).toBeUndefined();
    });

    it('preserves a canonical route when a built-in override is reverted', async () => {
      const caller = await createCallerForUser(owner.id);
      const freshOrg = await createTestOrganization('Revert Route Org', owner.id, 0, {}, false);
      const created = await caller.organizations.modes.create({
        organizationId: freshOrg.id,
        name: 'Custom Code',
        slug: 'code',
      });
      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: freshOrg.id,
        mode_slug: 'code',
        model_id: 'kilo-auto/frontier',
      });

      await caller.organizations.modes.delete({
        organizationId: freshOrg.id,
        modeId: created.mode.id,
        preserve_route: true,
      });

      const updatedOrganization = await getOrganizationById(freshOrg.id);
      expect(updatedOrganization?.settings.org_auto_model?.routes.code).toBe('kilo-auto/frontier');
    });

    it('updates a preserved route when a built-in override is reverted', async () => {
      const caller = await createCallerForUser(owner.id);
      const freshOrg = await createTestOrganization(
        'Revert Changed Route Org',
        owner.id,
        0,
        {},
        false
      );
      const created = await caller.organizations.modes.create({
        organizationId: freshOrg.id,
        name: 'Custom Code',
        slug: 'code',
      });
      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: freshOrg.id,
        mode_slug: 'code',
        model_id: 'kilo-auto/frontier',
      });

      await caller.organizations.modes.delete({
        organizationId: freshOrg.id,
        modeId: created.mode.id,
        preserve_route: true,
        route_model: 'kilo-auto/balanced',
      });

      const updatedOrganization = await getOrganizationById(freshOrg.id);
      expect(updatedOrganization?.settings.org_auto_model?.routes.code).toBe('kilo-auto/balanced');
    });

    it('rejects route_model when deleting a custom mode', async () => {
      const caller = await createCallerForUser(owner.id);
      const freshOrg = await createTestOrganization(
        'Delete Custom Route Org',
        owner.id,
        0,
        {},
        false
      );
      const created = await caller.organizations.modes.create({
        organizationId: freshOrg.id,
        name: 'Custom Route Mode',
        slug: 'custom-route-mode',
      });
      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: freshOrg.id,
        mode_slug: 'custom-route-mode',
        model_id: 'kilo-auto/frontier',
      });

      await expect(
        caller.organizations.modes.delete({
          organizationId: freshOrg.id,
          modeId: created.mode.id,
          route_model: 'kilo-auto/balanced',
        })
      ).rejects.toThrow('Route updates can only be preserved when reverting a built-in mode.');

      const updatedOrganization = await getOrganizationById(freshOrg.id);
      expect(updatedOrganization?.settings.org_auto_model?.routes['custom-route-mode']).toBe(
        'kilo-auto/frontier'
      );
      expect(
        (await getAllOrganizationModes(freshOrg.id)).find(mode => mode.id === created.mode.id)
      ).toBeDefined();
    });

    it('prevents members from preserving a routed built-in override', async () => {
      const caller = await createCallerForUser(owner.id);
      const freshOrg = await createTestOrganization(
        'Member Revert Route Org',
        owner.id,
        0,
        {},
        false
      );
      await addUserToOrganization(freshOrg.id, member.id, 'member');
      const created = await caller.organizations.modes.create({
        organizationId: freshOrg.id,
        name: 'Custom Code',
        slug: 'code',
      });
      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: freshOrg.id,
        mode_slug: 'code',
        model_id: 'kilo-auto/frontier',
      });

      const memberCaller = await createCallerForUser(member.id);
      await expect(
        memberCaller.organizations.modes.delete({
          organizationId: freshOrg.id,
          modeId: created.mode.id,
          preserve_route: true,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');

      const updatedOrganization = await getOrganizationById(freshOrg.id);
      expect(updatedOrganization?.settings.org_auto_model?.routes.code).toBe('kilo-auto/frontier');
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

    it('prevents members from deleting a mode with an Organization Auto route', async () => {
      const caller = await createCallerForUser(owner.id);
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Routed Mode',
        slug: 'routed-delete-test',
      });
      await caller.organizations.settings.setOrganizationAutoRoute({
        organizationId: testOrganization.id,
        mode_slug: 'routed-delete-test',
        model_id: 'kilo-auto/balanced',
      });

      const memberCaller = await createCallerForUser(member.id);
      await expect(
        memberCaller.organizations.modes.delete({
          organizationId: testOrganization.id,
          modeId: created.mode.id,
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');

      const updatedOrganization = await getOrganizationById(testOrganization.id);
      expect(updatedOrganization?.settings.org_auto_model?.routes['routed-delete-test']).toBe(
        'kilo-auto/balanced'
      );
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

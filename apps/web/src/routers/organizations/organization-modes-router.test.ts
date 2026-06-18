import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { addUserToOrganization } from '@/lib/organizations/organizations';
import { getAllOrganizationModes } from '@/lib/organizations/organization-modes';
import { db } from '@/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import type { User, Organization } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'crypto';

jest.mock('@/lib/posthog-feature-flags', () => ({
  isReleaseToggleEnabled: jest.fn(async () => true),
}));

const mockedIsReleaseToggleEnabled = jest.mocked(
  jest.requireMock('@/lib/posthog-feature-flags').isReleaseToggleEnabled
);

let owner: User;
let member: User;
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

    it('should allow an organization mode default that is not denied', async () => {
      const caller = await createCallerForUser(owner.id);
      const organization = await createTestOrganization(
        'Allowed Default Model Org',
        owner.id,
        0,
        { model_deny_list: ['anthropic/claude-3-opus'] },
        false
      );

      const result = await caller.organizations.modes.create({
        organizationId: organization.id,
        name: 'Code Mode',
        slug: 'code',
        config: {
          roleDefinition: 'You are a coding assistant',
          groups: ['read'],
          defaultModel: 'openai/gpt-4o',
        },
      });

      expect(result.mode.config.defaultModel).toBe('openai/gpt-4o');
    });

    it('should reject an organization mode default for a non-enterprise organization', async () => {
      const caller = await createCallerForUser(owner.id);
      const organization = await createTestOrganization(
        'Teams Default Model Org',
        owner.id,
        0,
        {},
        true
      );

      await expect(
        caller.organizations.modes.create({
          organizationId: organization.id,
          name: 'Code Mode',
          slug: 'code',
          config: {
            roleDefinition: 'You are a coding assistant',
            groups: ['read'],
            defaultModel: 'openai/gpt-4o',
          },
        })
      ).rejects.toThrow('Model access configuration is not available for this organization.');
    });

    it('should reject an organization mode default that is denied', async () => {
      const caller = await createCallerForUser(owner.id);
      const organization = await createTestOrganization(
        'Denied Default Model Org',
        owner.id,
        0,
        { model_deny_list: ['openai/gpt-4o'] },
        false
      );

      await expect(
        caller.organizations.modes.create({
          organizationId: organization.id,
          name: 'Code Mode',
          slug: 'code',
          config: {
            roleDefinition: 'You are a coding assistant',
            groups: ['read'],
            defaultModel: 'openai/gpt-4o',
          },
        })
      ).rejects.toThrow(
        "Default model 'openai/gpt-4o' is not in the organization's allowed models list"
      );
    });

    it('should reject an empty organization mode default', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.modes.create({
          organizationId: testOrganization.id,
          name: 'Code Mode',
          slug: 'empty-default-model',
          config: {
            roleDefinition: 'You are a coding assistant',
            groups: ['read'],
            defaultModel: '',
          },
        })
      ).rejects.toThrow();
    });

    it('should reject mode default writes when the release flag is disabled', async () => {
      mockedIsReleaseToggleEnabled.mockResolvedValueOnce(false);
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.modes.create({
          organizationId: testOrganization.id,
          name: 'Code Mode',
          slug: 'flag-disabled-default-model',
          config: {
            roleDefinition: 'You are a coding assistant',
            groups: ['read'],
            defaultModel: 'openai/gpt-4o',
          },
        })
      ).rejects.toThrow('Mode default model configuration is not available');
    });

    it('should allow mode default writes in development when the release flag is disabled', async () => {
      mockedIsReleaseToggleEnabled.mockResolvedValue(false);
      const replacedEnv = jest.replaceProperty(process, 'env', {
        ...process.env,
        NODE_ENV: 'development',
      });
      const caller = await createCallerForUser(owner.id);

      try {
        await expect(
          caller.organizations.modes.create({
            organizationId: testOrganization.id,
            name: 'Code Mode',
            slug: 'development-default-model',
            config: {
              roleDefinition: 'You are a coding assistant',
              groups: ['read'],
              defaultModel: 'openai/gpt-4o',
            },
          })
        ).resolves.toMatchObject({
          mode: {
            config: {
              defaultModel: 'openai/gpt-4o',
            },
          },
        });
      } finally {
        replacedEnv.restore();
      }
    });

    it('should reject a wildcard organization mode default', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.modes.create({
          organizationId: testOrganization.id,
          name: 'Code Mode',
          slug: 'wildcard-default-model',
          config: {
            roleDefinition: 'You are a coding assistant',
            groups: ['read'],
            defaultModel: 'openai/*',
          },
        })
      ).rejects.toThrow("Default model 'openai/*' is not a concrete model identifier");
    });

    it('should reject a wildcard organization mode default with a variant suffix', async () => {
      const caller = await createCallerForUser(owner.id);

      await expect(
        caller.organizations.modes.create({
          organizationId: testOrganization.id,
          name: 'Code Mode',
          slug: 'wildcard-variant-default-model',
          config: {
            roleDefinition: 'You are a coding assistant',
            groups: ['read'],
            defaultModel: 'openai/*:free',
          },
        })
      ).rejects.toThrow("Default model 'openai/*:free' is not a concrete model identifier");
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

    it('should reject an organization mode default on update for a non-enterprise organization', async () => {
      const caller = await createCallerForUser(owner.id);
      const organization = await createTestOrganization(
        'Teams Update Default Model Org',
        owner.id,
        0,
        {},
        true
      );
      const created = await caller.organizations.modes.create({
        organizationId: organization.id,
        name: 'Code Mode',
        slug: 'code',
        config: {
          roleDefinition: 'You are a coding assistant',
          groups: ['read'],
        },
      });

      await expect(
        caller.organizations.modes.update({
          organizationId: organization.id,
          modeId: created.mode.id,
          config: {
            defaultModel: 'openai/gpt-4o',
          },
        })
      ).rejects.toThrow('Model access configuration is not available for this organization.');
    });

    it('should reject a denied organization mode default on update', async () => {
      const caller = await createCallerForUser(owner.id);
      const organization = await createTestOrganization(
        'Denied Update Default Model Org',
        owner.id,
        0,
        { model_deny_list: ['openai/gpt-4o'] },
        false
      );
      const created = await caller.organizations.modes.create({
        organizationId: organization.id,
        name: 'Code Mode',
        slug: 'code',
        config: {
          roleDefinition: 'You are a coding assistant',
          groups: ['read'],
        },
      });

      await expect(
        caller.organizations.modes.update({
          organizationId: organization.id,
          modeId: created.mode.id,
          config: {
            defaultModel: 'openai/gpt-4o',
          },
        })
      ).rejects.toThrow(
        "Default model 'openai/gpt-4o' is not in the organization's allowed models list"
      );
    });

    it('should reject a wildcard organization mode default on update', async () => {
      const caller = await createCallerForUser(owner.id);
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Code Mode',
        slug: 'wildcard-update-default-model',
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
            defaultModel: 'openai/*',
          },
        })
      ).rejects.toThrow("Default model 'openai/*' is not a concrete model identifier");
    });

    it('should reject a wildcard organization mode default with a variant suffix on update', async () => {
      const caller = await createCallerForUser(owner.id);
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Code Mode',
        slug: 'wildcard-variant-update-default-model',
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
            defaultModel: 'openai/*:free',
          },
        })
      ).rejects.toThrow("Default model 'openai/*:free' is not a concrete model identifier");
    });

    it('should allow unrelated mode edits after a stored default becomes denied', async () => {
      const caller = await createCallerForUser(owner.id);
      const organization = await createTestOrganization(
        'Stale Default Model Org',
        owner.id,
        0,
        {},
        false
      );
      const created = await caller.organizations.modes.create({
        organizationId: organization.id,
        name: 'Code Mode',
        slug: 'stale-default-model',
        config: {
          roleDefinition: 'You are a coding assistant',
          groups: ['read'],
          defaultModel: 'openai/gpt-4o',
        },
      });
      await db
        .update(organizations)
        .set({ settings: { model_deny_list: ['openai/gpt-4o'] } })
        .where(eq(organizations.id, organization.id));

      await expect(
        caller.organizations.modes.update({
          organizationId: organization.id,
          modeId: created.mode.id,
          config: {
            description: 'Updated description',
          },
        })
      ).resolves.toMatchObject({
        mode: {
          config: {
            description: 'Updated description',
            defaultModel: 'openai/gpt-4o',
          },
        },
      });
    });

    it('should allow clearing a mode default after an enterprise organization downgrades', async () => {
      const caller = await createCallerForUser(owner.id);
      const organization = await createTestOrganization(
        'Downgraded Default Model Org',
        owner.id,
        0,
        {},
        false
      );
      const created = await caller.organizations.modes.create({
        organizationId: organization.id,
        name: 'Code Mode',
        slug: 'downgraded-clear-default-model',
        config: {
          roleDefinition: 'You are a coding assistant',
          groups: ['read'],
          defaultModel: 'openai/gpt-4o',
        },
      });
      await db
        .update(organizations)
        .set({ plan: 'teams' })
        .where(eq(organizations.id, organization.id));

      await expect(
        caller.organizations.modes.update({
          organizationId: organization.id,
          modeId: created.mode.id,
          config: {
            defaultModel: null,
          },
        })
      ).resolves.toMatchObject({
        mode: {
          config: {
            roleDefinition: 'You are a coding assistant',
          },
        },
      });
    });

    it('should reject clearing a mode default when the release flag is disabled', async () => {
      const caller = await createCallerForUser(owner.id);
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Code Mode',
        slug: 'flag-disabled-clear-default-model',
        config: {
          roleDefinition: 'You are a coding assistant',
          groups: ['read'],
          defaultModel: 'openai/gpt-4o',
        },
      });
      mockedIsReleaseToggleEnabled.mockResolvedValueOnce(false);

      await expect(
        caller.organizations.modes.update({
          organizationId: testOrganization.id,
          modeId: created.mode.id,
          config: {
            defaultModel: null,
          },
        })
      ).rejects.toThrow('Mode default model configuration is not available');
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

    it('should clear an organization mode default on update', async () => {
      const caller = await createCallerForUser(owner.id);
      const created = await caller.organizations.modes.create({
        organizationId: testOrganization.id,
        name: 'Code Mode',
        slug: 'clear-default-model',
        config: {
          roleDefinition: 'You are a coding assistant',
          description: 'Write code',
          groups: ['read'],
          defaultModel: 'openai/gpt-4o',
        },
      });

      const result = await caller.organizations.modes.update({
        organizationId: testOrganization.id,
        modeId: created.mode.id,
        config: {
          defaultModel: null,
        },
      });

      expect(result.mode.config).toEqual({
        roleDefinition: 'You are a coding assistant',
        description: 'Write code',
        groups: ['read'],
      });
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

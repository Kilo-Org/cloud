import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_environment_profiles,
  agent_environment_profile_vars,
  agent_environment_profile_commands,
  agent_environment_profile_repo_bindings,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { bindProfileToRepo, MASKED_SECRET_VALUE } from '@kilocode/cloud-agent-profile';
import type { User, Organization } from '@kilocode/db/schema';

describe('Agent Profiles Router', () => {
  let ownerUser: User;
  let memberUser: User;
  let otherUser: User;
  let organizationA: Organization;

  beforeAll(async () => {
    // Create test users
    ownerUser = await insertTestUser({
      google_user_email: 'agent-profiles-owner@example.com',
      google_user_name: 'Agent Profiles Owner',
    });

    memberUser = await insertTestUser({
      google_user_email: 'agent-profiles-member@example.com',
      google_user_name: 'Agent Profiles Member',
    });

    otherUser = await insertTestUser({
      google_user_email: 'agent-profiles-other@example.com',
      google_user_name: 'Other User',
    });

    // Create test organization
    organizationA = await createTestOrganization('Agent Profiles Test Org', ownerUser.id, 100000);

    // Add member to organization
    await addUserToOrganization(organizationA.id, memberUser.id, 'member');
  });

  afterEach(async () => {
    // Clean up profiles after each test
    // First delete vars and commands (due to FK constraints)
    const profiles = await db
      .select({ id: agent_environment_profiles.id })
      .from(agent_environment_profiles);

    for (const profile of profiles) {
      await db
        .delete(agent_environment_profile_vars)
        .where(eq(agent_environment_profile_vars.profile_id, profile.id));
      await db
        .delete(agent_environment_profile_commands)
        .where(eq(agent_environment_profile_commands.profile_id, profile.id));
    }

    // Then delete profiles
    await db
      .delete(agent_environment_profiles)
      .where(eq(agent_environment_profiles.owned_by_user_id, ownerUser.id));
    await db
      .delete(agent_environment_profiles)
      .where(eq(agent_environment_profiles.owned_by_user_id, memberUser.id));
    await db
      .delete(agent_environment_profiles)
      .where(eq(agent_environment_profiles.owned_by_user_id, otherUser.id));
    await db
      .delete(agent_environment_profiles)
      .where(eq(agent_environment_profiles.owned_by_organization_id, organizationA.id));
  });

  describe('User Profiles', () => {
    describe('create', () => {
      test('should create a new user profile', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const result = await caller.agentProfiles.create({
          name: 'My Profile',
          description: 'Test profile description',
        });

        expect(result.id).toBeDefined();

        // Verify profile exists in database
        const [dbProfile] = await db
          .select()
          .from(agent_environment_profiles)
          .where(eq(agent_environment_profiles.id, result.id));

        expect(dbProfile).toBeDefined();
        expect(dbProfile.name).toBe('My Profile');
        expect(dbProfile.description).toBe('Test profile description');
        expect(dbProfile.owned_by_user_id).toBe(ownerUser.id);
        expect(dbProfile.owned_by_organization_id).toBeNull();
      });

      test('should create profile without description', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const result = await caller.agentProfiles.create({
          name: 'Minimal Profile',
        });

        expect(result.id).toBeDefined();

        const [dbProfile] = await db
          .select()
          .from(agent_environment_profiles)
          .where(eq(agent_environment_profiles.id, result.id));

        expect(dbProfile.description).toBeNull();
      });
    });

    describe('list', () => {
      test('should return empty array when user has no profiles', async () => {
        const caller = await createCallerForUser(ownerUser.id);
        const result = await caller.agentProfiles.list({});

        expect(result).toEqual([]);
      });

      test('should return user profiles with counts', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        // Create a profile
        const { id: profileId } = await caller.agentProfiles.create({
          name: 'Test Profile',
        });

        // Add a var
        await caller.agentProfiles.setVar({
          profileId,
          key: 'TEST_VAR',
          value: 'test-value',
          isSecret: false,
        });

        // Add commands
        await caller.agentProfiles.setCommands({
          profileId,
          commands: ['npm install', 'npm test'],
        });

        const result = await caller.agentProfiles.list({});

        expect(result).toHaveLength(1);
        expect(result[0].name).toBe('Test Profile');
        expect(result[0].varCount).toBe(1);
        expect(result[0].commandCount).toBe(2);
      });

      test('should only return profiles owned by the user', async () => {
        const callerA = await createCallerForUser(ownerUser.id);
        const callerB = await createCallerForUser(otherUser.id);

        // Create profiles for both users
        await callerA.agentProfiles.create({ name: 'Owner Profile' });
        await callerB.agentProfiles.create({ name: 'Other Profile' });

        // Each user should only see their own profiles
        const resultA = await callerA.agentProfiles.list({});
        const resultB = await callerB.agentProfiles.list({});

        expect(resultA).toHaveLength(1);
        expect(resultA[0].name).toBe('Owner Profile');

        expect(resultB).toHaveLength(1);
        expect(resultB[0].name).toBe('Other Profile');
      });
    });

    describe('get', () => {
      test('should return profile with vars and commands', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const { id: profileId } = await caller.agentProfiles.create({
          name: 'Full Profile',
          description: 'A complete profile',
        });

        await caller.agentProfiles.setVar({
          profileId,
          key: 'API_KEY',
          value: 'secret-key',
          isSecret: true,
        });

        await caller.agentProfiles.setVar({
          profileId,
          key: 'DEBUG',
          value: 'true',
          isSecret: false,
        });

        await caller.agentProfiles.setCommands({
          profileId,
          commands: ['npm install'],
        });

        const result = await caller.agentProfiles.get({ profileId });

        expect(result.id).toBe(profileId);
        expect(result.name).toBe('Full Profile');
        expect(result.description).toBe('A complete profile');
        expect(result.vars).toHaveLength(2);
        expect(result.commands).toHaveLength(1);

        // Secret value should be masked
        const secretVar = result.vars.find(v => v.key === 'API_KEY');
        expect(secretVar?.value).toBe('***');
        expect(secretVar?.isSecret).toBe(true);

        // Non-secret value should be visible
        const debugVar = result.vars.find(v => v.key === 'DEBUG');
        expect(debugVar?.value).toBe('true');
        expect(debugVar?.isSecret).toBe(false);
      });

      test('should throw NOT_FOUND for non-existent profile', async () => {
        const caller = await createCallerForUser(ownerUser.id);
        const nonExistentId = '00000000-0000-0000-0000-000000000000';

        await expect(caller.agentProfiles.get({ profileId: nonExistentId })).rejects.toThrow(
          'Profile not found'
        );
      });

      test('should throw NOT_FOUND when accessing another user profile', async () => {
        const callerA = await createCallerForUser(ownerUser.id);
        const callerB = await createCallerForUser(otherUser.id);

        const { id: profileId } = await callerA.agentProfiles.create({
          name: 'Private Profile',
        });

        await expect(callerB.agentProfiles.get({ profileId })).rejects.toThrow('Profile not found');
      });
    });

    describe('update', () => {
      test('should update profile name and description', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const { id: profileId } = await caller.agentProfiles.create({
          name: 'Original Name',
          description: 'Original description',
        });

        await caller.agentProfiles.update({
          profileId,
          name: 'Updated Name',
          description: 'Updated description',
        });

        const result = await caller.agentProfiles.get({ profileId });

        expect(result.name).toBe('Updated Name');
        expect(result.description).toBe('Updated description');
      });
    });

    describe('delete', () => {
      test('should delete profile and cascade to vars and commands', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const { id: profileId } = await caller.agentProfiles.create({
          name: 'To Delete',
        });

        await caller.agentProfiles.setVar({
          profileId,
          key: 'VAR',
          value: 'value',
          isSecret: false,
        });

        await caller.agentProfiles.setCommands({
          profileId,
          commands: ['cmd'],
        });

        const result = await caller.agentProfiles.delete({ profileId });

        expect(result.success).toBe(true);

        // Verify profile is deleted
        const profiles = await db
          .select()
          .from(agent_environment_profiles)
          .where(eq(agent_environment_profiles.id, profileId));

        expect(profiles).toHaveLength(0);

        // Verify vars are deleted (cascade)
        const vars = await db
          .select()
          .from(agent_environment_profile_vars)
          .where(eq(agent_environment_profile_vars.profile_id, profileId));

        expect(vars).toHaveLength(0);

        // Verify commands are deleted (cascade)
        const commands = await db
          .select()
          .from(agent_environment_profile_commands)
          .where(eq(agent_environment_profile_commands.profile_id, profileId));

        expect(commands).toHaveLength(0);
      });
    });

    describe('setAsDefault', () => {
      test('should set profile as default', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const { id: profileId } = await caller.agentProfiles.create({
          name: 'Default Profile',
        });

        await caller.agentProfiles.setAsDefault({ profileId });

        const result = await caller.agentProfiles.get({ profileId });

        expect(result.isDefault).toBe(true);
      });

      test('should clear previous default when setting new default', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const { id: profile1Id } = await caller.agentProfiles.create({
          name: 'Profile 1',
        });

        const { id: profile2Id } = await caller.agentProfiles.create({
          name: 'Profile 2',
        });

        // Set profile 1 as default
        await caller.agentProfiles.setAsDefault({ profileId: profile1Id });

        // Set profile 2 as default
        await caller.agentProfiles.setAsDefault({ profileId: profile2Id });

        // Profile 1 should no longer be default
        const result1 = await caller.agentProfiles.get({ profileId: profile1Id });
        expect(result1.isDefault).toBe(false);

        // Profile 2 should be default
        const result2 = await caller.agentProfiles.get({ profileId: profile2Id });
        expect(result2.isDefault).toBe(true);
      });
    });

    describe('setVar', () => {
      test('should add a new variable', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const { id: profileId } = await caller.agentProfiles.create({
          name: 'Var Test',
        });

        await caller.agentProfiles.setVar({
          profileId,
          key: 'NEW_VAR',
          value: 'new-value',
          isSecret: false,
        });

        const result = await caller.agentProfiles.get({ profileId });

        expect(result.vars).toHaveLength(1);
        expect(result.vars[0].key).toBe('NEW_VAR');
        expect(result.vars[0].value).toBe('new-value');
      });

      test('should update existing variable', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const { id: profileId } = await caller.agentProfiles.create({
          name: 'Var Update Test',
        });

        await caller.agentProfiles.setVar({
          profileId,
          key: 'VAR',
          value: 'original',
          isSecret: false,
        });

        await caller.agentProfiles.setVar({
          profileId,
          key: 'VAR',
          value: 'updated',
          isSecret: false,
        });

        const result = await caller.agentProfiles.get({ profileId });

        expect(result.vars).toHaveLength(1);
        expect(result.vars[0].value).toBe('updated');
      });

      test('should mask secret values in response', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const { id: profileId } = await caller.agentProfiles.create({
          name: 'Secret Test',
        });

        await caller.agentProfiles.setVar({
          profileId,
          key: 'SECRET',
          value: 'super-secret-value',
          isSecret: true,
        });

        const result = await caller.agentProfiles.get({ profileId });

        expect(result.vars[0].value).toBe('***');
        expect(result.vars[0].isSecret).toBe(true);
      });
    });

    describe('deleteVar', () => {
      test('should delete a variable', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const { id: profileId } = await caller.agentProfiles.create({
          name: 'Delete Var Test',
        });

        await caller.agentProfiles.setVar({
          profileId,
          key: 'TO_DELETE',
          value: 'value',
          isSecret: false,
        });

        await caller.agentProfiles.deleteVar({
          profileId,
          key: 'TO_DELETE',
        });

        const result = await caller.agentProfiles.get({ profileId });

        expect(result.vars).toHaveLength(0);
      });

      test('should throw NOT_FOUND for non-existent variable', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const { id: profileId } = await caller.agentProfiles.create({
          name: 'No Var Test',
        });

        await expect(
          caller.agentProfiles.deleteVar({
            profileId,
            key: 'NON_EXISTENT',
          })
        ).rejects.toThrow('Environment variable not found');
      });
    });

    describe('setCommands', () => {
      test('should set commands', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const { id: profileId } = await caller.agentProfiles.create({
          name: 'Commands Test',
        });

        await caller.agentProfiles.setCommands({
          profileId,
          commands: ['npm install', 'npm run build', 'npm test'],
        });

        const result = await caller.agentProfiles.get({ profileId });

        expect(result.commands).toHaveLength(3);
        expect(result.commands[0].sequence).toBe(0);
        expect(result.commands[0].command).toBe('npm install');
        expect(result.commands[1].sequence).toBe(1);
        expect(result.commands[1].command).toBe('npm run build');
        expect(result.commands[2].sequence).toBe(2);
        expect(result.commands[2].command).toBe('npm test');
      });

      test('should replace existing commands', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const { id: profileId } = await caller.agentProfiles.create({
          name: 'Replace Commands Test',
        });

        await caller.agentProfiles.setCommands({
          profileId,
          commands: ['old command 1', 'old command 2'],
        });

        await caller.agentProfiles.setCommands({
          profileId,
          commands: ['new command'],
        });

        const result = await caller.agentProfiles.get({ profileId });

        expect(result.commands).toHaveLength(1);
        expect(result.commands[0].command).toBe('new command');
      });

      test('should clear commands when empty array provided', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const { id: profileId } = await caller.agentProfiles.create({
          name: 'Clear Commands Test',
        });

        await caller.agentProfiles.setCommands({
          profileId,
          commands: ['some command'],
        });

        await caller.agentProfiles.setCommands({
          profileId,
          commands: [],
        });

        const result = await caller.agentProfiles.get({ profileId });

        expect(result.commands).toHaveLength(0);
      });
    });
  });

  describe('Organization Profiles', () => {
    describe('create', () => {
      test('should create organization profile', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        const result = await caller.agentProfiles.create({
          organizationId: organizationA.id,
          name: 'Org Profile',
          description: 'Organization profile',
        });

        expect(result.id).toBeDefined();

        const [dbProfile] = await db
          .select()
          .from(agent_environment_profiles)
          .where(eq(agent_environment_profiles.id, result.id));

        expect(dbProfile.owned_by_organization_id).toBe(organizationA.id);
        expect(dbProfile.owned_by_user_id).toBeNull();
      });

      test('should require an organization manager role to create profiles', async () => {
        const caller = await createCallerForUser(memberUser.id);

        await expect(
          caller.agentProfiles.create({
            organizationId: organizationA.id,
            name: 'Member Created Profile',
          })
        ).rejects.toThrow(
          'You do not have the required organizational role to access this feature'
        );
      });

      test('should throw UNAUTHORIZED for non-members', async () => {
        const caller = await createCallerForUser(otherUser.id);

        await expect(
          caller.agentProfiles.create({
            organizationId: organizationA.id,
            name: 'Unauthorized Profile',
          })
        ).rejects.toThrow('You do not have access to this organization');
      });
    });

    describe('list', () => {
      test('should list organization profiles', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        await caller.agentProfiles.create({
          organizationId: organizationA.id,
          name: 'Org Profile 1',
        });

        await caller.agentProfiles.create({
          organizationId: organizationA.id,
          name: 'Org Profile 2',
        });

        const result = await caller.agentProfiles.list({
          organizationId: organizationA.id,
        });

        expect(result).toHaveLength(2);
      });

      test('should not mix user and org profiles', async () => {
        const caller = await createCallerForUser(ownerUser.id);

        // Create user profile
        await caller.agentProfiles.create({
          name: 'User Profile',
        });

        // Create org profile
        await caller.agentProfiles.create({
          organizationId: organizationA.id,
          name: 'Org Profile',
        });

        // List user profiles
        const userProfiles = await caller.agentProfiles.list({});
        expect(userProfiles).toHaveLength(1);
        expect(userProfiles[0].name).toBe('User Profile');

        // List org profiles
        const orgProfiles = await caller.agentProfiles.list({
          organizationId: organizationA.id,
        });
        expect(orgProfiles).toHaveLength(1);
        expect(orgProfiles[0].name).toBe('Org Profile');
      });
    });

    describe('access control', () => {
      test('should allow all org members to read org profiles', async () => {
        const ownerCaller = await createCallerForUser(ownerUser.id);
        const memberCaller = await createCallerForUser(memberUser.id);

        const { id: profileId } = await ownerCaller.agentProfiles.create({
          organizationId: organizationA.id,
          name: 'Shared Org Profile',
        });

        // Member can get the profile
        const result = await memberCaller.agentProfiles.get({
          organizationId: organizationA.id,
          profileId,
        });

        expect(result.name).toBe('Shared Org Profile');

        // Member can list org profiles
        const listed = await memberCaller.agentProfiles.list({
          organizationId: organizationA.id,
        });
        expect(listed.some(profile => profile.id === profileId)).toBe(true);
      });

      test('should prevent non-members from accessing org profiles', async () => {
        const ownerCaller = await createCallerForUser(ownerUser.id);
        const otherCaller = await createCallerForUser(otherUser.id);

        const { id: profileId } = await ownerCaller.agentProfiles.create({
          organizationId: organizationA.id,
          name: 'Private Org Profile',
        });

        await expect(
          otherCaller.agentProfiles.get({
            organizationId: organizationA.id,
            profileId,
          })
        ).rejects.toThrow('You do not have access to this organization');
      });

      describe('profile mutations are reserved for organization managers', () => {
        async function createOrgProfile(): Promise<string> {
          const ownerCaller = await createCallerForUser(ownerUser.id);
          const { id } = await ownerCaller.agentProfiles.create({
            organizationId: organizationA.id,
            name: 'Managed Org Profile',
          });
          return id;
        }

        async function expectMemberRejected(attempt: Promise<unknown>): Promise<void> {
          await expect(attempt).rejects.toThrow(
            'You do not have the required organizational role to access this feature'
          );
        }

        test('update: rejects a member and allows an admin', async () => {
          const memberCaller = await createCallerForUser(memberUser.id);
          const profileId = await createOrgProfile();

          await expectMemberRejected(
            memberCaller.agentProfiles.update({
              organizationId: organizationA.id,
              profileId,
              name: 'Renamed by member',
            })
          );
        });

        test('delete: rejects a member and allows an admin', async () => {
          const ownerCaller = await createCallerForUser(ownerUser.id);
          const memberCaller = await createCallerForUser(memberUser.id);
          const profileId = await createOrgProfile();

          await expectMemberRejected(
            memberCaller.agentProfiles.delete({ organizationId: organizationA.id, profileId })
          );

          await ownerCaller.agentProfiles.delete({ organizationId: organizationA.id, profileId });
        });

        test('setAsDefault and clearDefault: reject a member and allow an admin', async () => {
          const ownerCaller = await createCallerForUser(ownerUser.id);
          const memberCaller = await createCallerForUser(memberUser.id);
          const profileId = await createOrgProfile();

          await expectMemberRejected(
            memberCaller.agentProfiles.setAsDefault({ organizationId: organizationA.id, profileId })
          );
          await expectMemberRejected(
            memberCaller.agentProfiles.clearDefault({
              organizationId: organizationA.id,
              profileId,
            })
          );

          await ownerCaller.agentProfiles.setAsDefault({
            organizationId: organizationA.id,
            profileId,
          });
          await ownerCaller.agentProfiles.clearDefault({
            organizationId: organizationA.id,
            profileId,
          });
        });

        test('setVar and setCommands: reject a member and allow an admin', async () => {
          const ownerCaller = await createCallerForUser(ownerUser.id);
          const memberCaller = await createCallerForUser(memberUser.id);
          const profileId = await createOrgProfile();

          await expectMemberRejected(
            memberCaller.agentProfiles.setVar({
              organizationId: organizationA.id,
              profileId,
              key: 'MEMBER_VAR',
              value: 'member-value',
              isSecret: false,
            })
          );
          await expectMemberRejected(
            memberCaller.agentProfiles.setCommands({
              organizationId: organizationA.id,
              profileId,
              commands: ['echo member'],
            })
          );

          await ownerCaller.agentProfiles.setVar({
            organizationId: organizationA.id,
            profileId,
            key: 'ADMIN_VAR',
            value: 'admin-value',
            isSecret: false,
          });
          await ownerCaller.agentProfiles.setCommands({
            organizationId: organizationA.id,
            profileId,
            commands: ['echo admin'],
          });
        });

        test('MCP server create and update: reject a member and allow an admin', async () => {
          const ownerCaller = await createCallerForUser(ownerUser.id);
          const memberCaller = await createCallerForUser(memberUser.id);
          const profileId = await createOrgProfile();

          await expectMemberRejected(
            memberCaller.agentProfiles.createMcp({
              organizationId: organizationA.id,
              profileId,
              server: {
                name: 'member-server',
                type: 'remote',
                enabled: true,
                config: { type: 'remote', url: 'https://member.example.com/mcp' },
              } as never,
            })
          );

          const { id: mcpServerId } = await ownerCaller.agentProfiles.createMcp({
            organizationId: organizationA.id,
            profileId,
            server: {
              name: 'admin-server',
              type: 'remote',
              enabled: true,
              config: { type: 'remote', url: 'https://admin.example.com/mcp' },
            } as never,
          });

          await expectMemberRejected(
            memberCaller.agentProfiles.updateMcp({
              organizationId: organizationA.id,
              profileId,
              mcpServerId,
              server: {
                name: 'admin-server',
                type: 'remote',
                enabled: true,
                config: { type: 'remote', url: 'https://member.example.com/mcp' },
              } as never,
            })
          );
        });

        test('MCP masked header values survive an unchanged URL and are refused on a URL change', async () => {
          const ownerCaller = await createCallerForUser(ownerUser.id);
          const profileId = await createOrgProfile();

          const { id: mcpServerId } = await ownerCaller.agentProfiles.createMcp({
            organizationId: organizationA.id,
            profileId,
            server: {
              name: 'secret-server',
              type: 'remote',
              enabled: true,
              config: {
                type: 'remote',
                url: 'https://gateway.example.com/mcp',
                headers: { Authorization: 'Bearer original-value' },
              } as never,
            },
          });

          // Same URL with the masked placeholder round-trips the stored value.
          await ownerCaller.agentProfiles.updateMcp({
            organizationId: organizationA.id,
            profileId,
            mcpServerId,
            server: {
              name: 'secret-server',
              type: 'remote',
              enabled: true,
              config: {
                type: 'remote',
                url: 'https://gateway.example.com/mcp',
                headers: { Authorization: MASKED_SECRET_VALUE },
              } as never,
            },
          });

          // A different URL with the masked placeholder is refused; the value
          // must be submitted again for the new destination.
          await expect(
            ownerCaller.agentProfiles.updateMcp({
              organizationId: organizationA.id,
              profileId,
              mcpServerId,
              server: {
                name: 'secret-server',
                type: 'remote',
                enabled: true,
                config: {
                  type: 'remote',
                  url: 'https://other.example.com/mcp',
                  headers: { Authorization: MASKED_SECRET_VALUE },
                } as never,
              },
            })
          ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        });

        test('local command changes and transport changes require fresh MCP values', async () => {
          const ownerCaller = await createCallerForUser(ownerUser.id);
          const profileId = await createOrgProfile();

          const { id: mcpServerId } = await ownerCaller.agentProfiles.createMcp({
            organizationId: organizationA.id,
            profileId,
            server: {
              name: 'local-server',
              type: 'local',
              enabled: true,
              config: {
                type: 'local',
                command: ['node', 'server.js', '--config', 'my config.json'],
                environment: { API_KEY: 'original-value' },
              } as never,
            },
          });

          // An unchanged command array keeps the stored value, including an
          // argument that contains a space.
          await ownerCaller.agentProfiles.updateMcp({
            organizationId: organizationA.id,
            profileId,
            mcpServerId,
            server: {
              name: 'local-server',
              type: 'local',
              enabled: false,
              config: {
                type: 'local',
                command: ['node', 'server.js', '--config', 'my config.json'],
                environment: { API_KEY: MASKED_SECRET_VALUE },
              } as never,
            },
          });

          await expect(
            ownerCaller.agentProfiles.updateMcp({
              organizationId: organizationA.id,
              profileId,
              mcpServerId,
              server: {
                name: 'local-server',
                type: 'local',
                enabled: true,
                config: {
                  type: 'local',
                  command: ['node', 'other.js'],
                  environment: { API_KEY: MASKED_SECRET_VALUE },
                } as never,
              },
            })
          ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

          // Switching transport is a destination change too.
          await expect(
            ownerCaller.agentProfiles.updateMcp({
              organizationId: organizationA.id,
              profileId,
              mcpServerId,
              server: {
                name: 'local-server',
                type: 'remote',
                enabled: true,
                config: {
                  type: 'remote',
                  url: 'https://gateway.example.com/mcp',
                  headers: { Authorization: MASKED_SECRET_VALUE },
                } as never,
              },
            })
          ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        });

        test('skills: reject a member and allow an admin', async () => {
          const ownerCaller = await createCallerForUser(ownerUser.id);
          const memberCaller = await createCallerForUser(memberUser.id);
          const profileId = await createOrgProfile();

          await expectMemberRejected(
            memberCaller.agentProfiles.createCustomSkill({
              organizationId: organizationA.id,
              profileId,
              name: 'member-skill',
              rawMarkdown: '# Member skill\n',
            })
          );

          const { id: skillId } = await ownerCaller.agentProfiles.createCustomSkill({
            organizationId: organizationA.id,
            profileId,
            name: 'admin-skill',
            rawMarkdown: '# Admin skill\n',
          });

          await expectMemberRejected(
            memberCaller.agentProfiles.setSkillEnabled({
              organizationId: organizationA.id,
              profileId,
              skillId,
              enabled: false,
            })
          );
          await expectMemberRejected(
            memberCaller.agentProfiles.updateSkill({
              organizationId: organizationA.id,
              profileId,
              skillId,
              name: 'member-renamed-skill',
            })
          );
          await expectMemberRejected(
            memberCaller.agentProfiles.deleteSkill({
              organizationId: organizationA.id,
              profileId,
              skillId,
            })
          );

          await ownerCaller.agentProfiles.setSkillEnabled({
            organizationId: organizationA.id,
            profileId,
            skillId,
            enabled: false,
          });
          await ownerCaller.agentProfiles.updateSkill({
            organizationId: organizationA.id,
            profileId,
            skillId,
            name: 'admin-renamed-skill',
          });
          await ownerCaller.agentProfiles.deleteSkill({
            organizationId: organizationA.id,
            profileId,
            skillId,
          });
        });

        test('agents: reject a member and allow an admin', async () => {
          const ownerCaller = await createCallerForUser(ownerUser.id);
          const memberCaller = await createCallerForUser(memberUser.id);
          const profileId = await createOrgProfile();

          await expectMemberRejected(
            memberCaller.agentProfiles.createAgent({
              organizationId: organizationA.id,
              profileId,
              slug: 'member-agent',
              name: 'Member Agent',
              config: {},
            })
          );

          const { id: agentId } = await ownerCaller.agentProfiles.createAgent({
            organizationId: organizationA.id,
            profileId,
            slug: 'admin-agent',
            name: 'Admin Agent',
            config: {},
          });

          await expectMemberRejected(
            memberCaller.agentProfiles.updateAgent({
              organizationId: organizationA.id,
              profileId,
              agentId,
              name: 'Member Renamed Agent',
            })
          );
          await expectMemberRejected(
            memberCaller.agentProfiles.deleteAgent({
              organizationId: organizationA.id,
              profileId,
              agentId,
            })
          );

          await ownerCaller.agentProfiles.updateAgent({
            organizationId: organizationA.id,
            profileId,
            agentId,
            name: 'Admin Renamed Agent',
          });
          await ownerCaller.agentProfiles.deleteAgent({
            organizationId: organizationA.id,
            profileId,
            agentId,
          });
        });

        test('agents: authority is decided before a duplicate slug is reported', async () => {
          const ownerCaller = await createCallerForUser(ownerUser.id);
          const memberCaller = await createCallerForUser(memberUser.id);
          const profileId = await createOrgProfile();

          await ownerCaller.agentProfiles.createAgent({
            organizationId: organizationA.id,
            profileId,
            slug: 'shared-agent',
            name: 'Shared Agent',
            config: {},
          });

          await expectMemberRejected(
            memberCaller.agentProfiles.createAgent({
              organizationId: organizationA.id,
              profileId,
              slug: 'shared-agent',
              name: 'Duplicate Agent',
              config: {},
            })
          );
        });

        test('kilo commands: reject a member and allow an admin', async () => {
          const ownerCaller = await createCallerForUser(ownerUser.id);
          const memberCaller = await createCallerForUser(memberUser.id);
          const profileId = await createOrgProfile();

          await expectMemberRejected(
            memberCaller.agentProfiles.createKiloCommand({
              organizationId: organizationA.id,
              profileId,
              name: 'member-command',
              template: 'echo member',
            })
          );

          const { id: commandId } = await ownerCaller.agentProfiles.createKiloCommand({
            organizationId: organizationA.id,
            profileId,
            name: 'admin-command',
            template: 'echo admin',
          });

          await expectMemberRejected(
            memberCaller.agentProfiles.updateKiloCommand({
              organizationId: organizationA.id,
              profileId,
              commandId,
              template: 'echo member',
            })
          );
          await expectMemberRejected(
            memberCaller.agentProfiles.setKiloCommandEnabled({
              organizationId: organizationA.id,
              profileId,
              commandId,
              enabled: false,
            })
          );
          await expectMemberRejected(
            memberCaller.agentProfiles.reorderKiloCommands({
              organizationId: organizationA.id,
              profileId,
              orderedIds: [commandId],
            })
          );
          await expectMemberRejected(
            memberCaller.agentProfiles.deleteKiloCommand({
              organizationId: organizationA.id,
              profileId,
              commandId,
            })
          );

          await ownerCaller.agentProfiles.updateKiloCommand({
            organizationId: organizationA.id,
            profileId,
            commandId,
            template: 'echo admin updated',
          });
          await ownerCaller.agentProfiles.setKiloCommandEnabled({
            organizationId: organizationA.id,
            profileId,
            commandId,
            enabled: false,
          });
          await ownerCaller.agentProfiles.reorderKiloCommands({
            organizationId: organizationA.id,
            profileId,
            orderedIds: [commandId],
          });
          await ownerCaller.agentProfiles.deleteKiloCommand({
            organizationId: organizationA.id,
            profileId,
            commandId,
          });
        });

        test('instructions: reject a member and allow an admin', async () => {
          const ownerCaller = await createCallerForUser(ownerUser.id);
          const memberCaller = await createCallerForUser(memberUser.id);
          const profileId = await createOrgProfile();

          await expectMemberRejected(
            memberCaller.agentProfiles.createInstruction({
              organizationId: organizationA.id,
              profileId,
              name: 'member-rules',
              content: 'Follow the member rules.',
            })
          );

          const { id: instructionId } = await ownerCaller.agentProfiles.createInstruction({
            organizationId: organizationA.id,
            profileId,
            name: 'admin-rules',
            content: 'Follow the admin rules.',
          });

          await expectMemberRejected(
            memberCaller.agentProfiles.updateInstruction({
              organizationId: organizationA.id,
              profileId,
              instructionId,
              content: 'Follow the member rules.',
            })
          );
          await expectMemberRejected(
            memberCaller.agentProfiles.setInstructionEnabled({
              organizationId: organizationA.id,
              profileId,
              instructionId,
              enabled: false,
            })
          );
          await expectMemberRejected(
            memberCaller.agentProfiles.deleteInstruction({
              organizationId: organizationA.id,
              profileId,
              instructionId,
            })
          );

          await ownerCaller.agentProfiles.updateInstruction({
            organizationId: organizationA.id,
            profileId,
            instructionId,
            content: 'Follow the updated admin rules.',
          });
          await ownerCaller.agentProfiles.setInstructionEnabled({
            organizationId: organizationA.id,
            profileId,
            instructionId,
            enabled: false,
          });
          await ownerCaller.agentProfiles.deleteInstruction({
            organizationId: organizationA.id,
            profileId,
            instructionId,
          });
        });
      });
    });
  });

  describe('Repository bindings', () => {
    async function createOrgProfile(): Promise<string> {
      const ownerCaller = await createCallerForUser(ownerUser.id);
      const { id } = await ownerCaller.agentProfiles.create({
        organizationId: organizationA.id,
        name: 'Bound Org Profile',
      });
      return id;
    }

    async function orgBindings() {
      return db
        .select()
        .from(agent_environment_profile_repo_bindings)
        .where(
          eq(agent_environment_profile_repo_bindings.owned_by_organization_id, organizationA.id)
        );
    }

    test('rejects a member bind and allows an admin bind', async () => {
      const ownerCaller = await createCallerForUser(ownerUser.id);
      const memberCaller = await createCallerForUser(memberUser.id);
      const profileId = await createOrgProfile();

      await expect(
        memberCaller.agentProfiles.bindToRepo({
          organizationId: organizationA.id,
          profileId,
          repoFullName: 'acme/web',
          platform: 'github',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');

      await ownerCaller.agentProfiles.bindToRepo({
        organizationId: organizationA.id,
        profileId,
        repoFullName: 'acme/web',
        platform: 'github',
      });
      expect(await orgBindings()).toHaveLength(1);
    });

    test('rejects a member unbind and allows an admin unbind', async () => {
      const ownerCaller = await createCallerForUser(ownerUser.id);
      const memberCaller = await createCallerForUser(memberUser.id);
      const profileId = await createOrgProfile();
      await ownerCaller.agentProfiles.bindToRepo({
        organizationId: organizationA.id,
        profileId,
        repoFullName: 'acme/web',
        platform: 'github',
      });

      await expect(
        memberCaller.agentProfiles.unbindRepo({
          organizationId: organizationA.id,
          repoFullName: 'acme/web',
          platform: 'github',
        })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');

      await ownerCaller.agentProfiles.unbindRepo({
        organizationId: organizationA.id,
        repoFullName: 'acme/web',
        platform: 'github',
      });
      expect(await orgBindings()).toHaveLength(0);
    });

    test('denies a member deleting a bound profile but lets an admin', async () => {
      const ownerCaller = await createCallerForUser(ownerUser.id);
      const memberCaller = await createCallerForUser(memberUser.id);
      const profileId = await createOrgProfile();
      await ownerCaller.agentProfiles.bindToRepo({
        organizationId: organizationA.id,
        profileId,
        repoFullName: 'acme/web',
        platform: 'github',
      });

      await expect(
        memberCaller.agentProfiles.delete({ organizationId: organizationA.id, profileId })
      ).rejects.toThrow('You do not have the required organizational role to access this feature');

      await ownerCaller.agentProfiles.delete({ organizationId: organizationA.id, profileId });
      expect(await orgBindings()).toHaveLength(0);
      const profile = await db
        .select()
        .from(agent_environment_profiles)
        .where(eq(agent_environment_profiles.id, profileId));
      expect(profile).toHaveLength(0);
    });

    test('removes the binding when its profile is deleted', async () => {
      const ownerCaller = await createCallerForUser(ownerUser.id);
      const profileId = await createOrgProfile();
      await ownerCaller.agentProfiles.bindToRepo({
        organizationId: organizationA.id,
        profileId,
        repoFullName: 'acme/web',
        platform: 'github',
      });
      expect(await orgBindings()).toHaveLength(1);

      await ownerCaller.agentProfiles.delete({ organizationId: organizationA.id, profileId });
      expect(await orgBindings()).toHaveLength(0);
    });

    test('serializes an admin delete behind a concurrent bind on the profile row lock', async () => {
      const adminCaller = await createCallerForUser(ownerUser.id);
      const profileId = await createOrgProfile();
      const owner = { type: 'organization' as const, id: organizationA.id };

      let pendingDelete: Promise<unknown> | undefined;
      await db.transaction(async tx => {
        // The bind holds the profile row lock for the whole transaction.
        await bindProfileToRepo(tx, owner, 'acme/race', 'github', profileId);
        // Start the delete while the binding is still uncommitted; the row
        // lock makes it wait instead of observing zero bindings.
        pendingDelete = adminCaller.agentProfiles.delete({
          organizationId: organizationA.id,
          profileId,
        });
        // Real wall-clock pause, deliberate: the pending delete must observe
        // the uncommitted binding, and fake timers do not control Postgres.
        await new Promise(resolve => setTimeout(resolve, 200));
      });

      await pendingDelete;

      const bindings = await db
        .select()
        .from(agent_environment_profile_repo_bindings)
        .where(eq(agent_environment_profile_repo_bindings.profile_id, profileId));
      expect(bindings).toHaveLength(0);
      const profile = await db
        .select()
        .from(agent_environment_profiles)
        .where(eq(agent_environment_profiles.id, profileId));
      expect(profile).toHaveLength(0);
    });
  });
});

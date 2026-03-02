import { describe, test, expect, beforeAll, afterEach } from '@jest/globals';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { addUserToOrganization } from '@/lib/organizations/organizations';
import { db } from '@/lib/drizzle';
import {
  agent_environment_profiles,
  agent_environment_profile_vars,
  agent_environment_profile_commands,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
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

      test('should allow org members to create profiles', async () => {
        const caller = await createCallerForUser(memberUser.id);

        const result = await caller.agentProfiles.create({
          organizationId: organizationA.id,
          name: 'Member Created Profile',
        });

        expect(result.id).toBeDefined();
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
      test('should allow all org members to access org profiles', async () => {
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
    });
  });
});

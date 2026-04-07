import { db } from '@/lib/drizzle';
import {
  agent_environment_profiles,
  agent_environment_profile_vars,
  agent_environment_profile_commands,
  agent_environment_profile_repo_bindings,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { mergeProfileConfiguration, ProfileNotFoundError } from './profile-session-config';
import type { ProfileOwner } from './types';

// A valid encrypted envelope JSON that satisfies the zod schema
const fakeEnvelope = JSON.stringify({
  encryptedData: 'dGVzdC1lbmNyeXB0ZWQtZGF0YQ==',
  encryptedDEK: 'dGVzdC1lbmNyeXB0ZWQtZGVr',
  algorithm: 'rsa-aes-256-gcm',
  version: 1,
});

async function createProfile(
  owner: ProfileOwner,
  name: string,
  opts: { isDefault?: boolean } = {}
): Promise<string> {
  const [row] = await db
    .insert(agent_environment_profiles)
    .values({
      owned_by_user_id: owner.type === 'user' ? owner.id : null,
      owned_by_organization_id: owner.type === 'organization' ? owner.id : null,
      name,
      is_default: opts.isDefault ?? false,
    })
    .returning({ id: agent_environment_profiles.id });
  return row.id;
}

async function addVar(
  profileId: string,
  key: string,
  value: string,
  isSecret = false
): Promise<void> {
  await db.insert(agent_environment_profile_vars).values({
    profile_id: profileId,
    key,
    value,
    is_secret: isSecret,
  });
}

async function addCommands(profileId: string, commands: string[]): Promise<void> {
  if (commands.length === 0) return;
  await db.insert(agent_environment_profile_commands).values(
    commands.map((command, i) => ({
      profile_id: profileId,
      sequence: i,
      command,
    }))
  );
}

async function bindRepo(
  owner: ProfileOwner,
  repoFullName: string,
  platform: 'github' | 'gitlab',
  profileId: string
): Promise<void> {
  await db.insert(agent_environment_profile_repo_bindings).values({
    repo_full_name: repoFullName,
    platform,
    profile_id: profileId,
    owned_by_user_id: owner.type === 'user' ? owner.id : null,
    owned_by_organization_id: owner.type === 'organization' ? owner.id : null,
  });
}

describe('mergeProfileConfiguration', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(agent_environment_profile_repo_bindings);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(agent_environment_profile_commands);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(agent_environment_profile_vars);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(agent_environment_profiles);
  });

  test('returns all undefined when no profiles and no manual args', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    const result = await mergeProfileConfiguration({ owner });

    expect(result).toEqual({
      envVars: undefined,
      setupCommands: undefined,
      encryptedSecrets: undefined,
    });
  });

  test('passes through manual envVars only', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    const result = await mergeProfileConfiguration({
      owner,
      envVars: { FOO: 'bar' },
    });

    expect(result.envVars).toEqual({ FOO: 'bar' });
    expect(result.setupCommands).toBeUndefined();
    expect(result.encryptedSecrets).toBeUndefined();
  });

  test('passes through manual setupCommands only', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    const result = await mergeProfileConfiguration({
      owner,
      setupCommands: ['npm install'],
    });

    expect(result.envVars).toBeUndefined();
    expect(result.setupCommands).toEqual(['npm install']);
    expect(result.encryptedSecrets).toBeUndefined();
  });

  test('loads default profile for user owner', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'my-default', { isDefault: true });
    await addVar(profileId, 'DB_HOST', 'localhost');
    await addCommands(profileId, ['echo hello']);

    const result = await mergeProfileConfiguration({ owner });

    expect(result.envVars).toEqual({ DB_HOST: 'localhost' });
    expect(result.setupCommands).toEqual(['echo hello']);
  });

  test('loads named profile by name', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'staging');
    await addVar(profileId, 'ENV', 'staging');
    await addCommands(profileId, ['setup.sh']);

    const result = await mergeProfileConfiguration({
      owner,
      profileName: 'staging',
    });

    expect(result.envVars).toEqual({ ENV: 'staging' });
    expect(result.setupCommands).toEqual(['setup.sh']);
  });

  test('throws ProfileNotFoundError for unknown profile name', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    await expect(mergeProfileConfiguration({ owner, profileName: 'nonexistent' })).rejects.toThrow(
      ProfileNotFoundError
    );
  });

  test('loads repo binding profile as base layer', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'repo-profile');
    await addVar(profileId, 'REPO_VAR', 'bound');
    await addCommands(profileId, ['repo-setup']);
    await bindRepo(owner, 'org/repo', 'github', profileId);

    const result = await mergeProfileConfiguration({
      owner,
      repoFullName: 'org/repo',
      platform: 'github',
    });

    expect(result.envVars).toEqual({ REPO_VAR: 'bound' });
    expect(result.setupCommands).toEqual(['repo-setup']);
  });

  test('merges repo binding (base) with override profile and manual args', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    // Base: repo binding profile
    const baseProfileId = await createProfile(owner, 'base-profile');
    await addVar(baseProfileId, 'SHARED', 'from-base');
    await addVar(baseProfileId, 'BASE_ONLY', 'base-val');
    await addCommands(baseProfileId, ['base-cmd']);
    await bindRepo(owner, 'org/repo', 'github', baseProfileId);

    // Override: default profile
    const overrideProfileId = await createProfile(owner, 'override-profile', { isDefault: true });
    await addVar(overrideProfileId, 'SHARED', 'from-override');
    await addVar(overrideProfileId, 'OVERRIDE_ONLY', 'override-val');
    await addCommands(overrideProfileId, ['override-cmd']);

    const result = await mergeProfileConfiguration({
      owner,
      repoFullName: 'org/repo',
      platform: 'github',
      envVars: { SHARED: 'from-manual', MANUAL: 'manual-val' },
      setupCommands: ['manual-cmd'],
    });

    // Env vars: base < override < manual
    expect(result.envVars).toEqual({
      BASE_ONLY: 'base-val',
      OVERRIDE_ONLY: 'override-val',
      SHARED: 'from-manual',
      MANUAL: 'manual-val',
    });
    // Commands: base, override, manual (concatenated)
    expect(result.setupCommands).toEqual(['base-cmd', 'override-cmd', 'manual-cmd']);
  });

  test('deduplicates when repo binding and override resolve to same profile', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'shared-profile', { isDefault: true });
    await addVar(profileId, 'KEY', 'val');
    await addCommands(profileId, ['cmd']);
    await bindRepo(owner, 'org/repo', 'github', profileId);

    const result = await mergeProfileConfiguration({
      owner,
      repoFullName: 'org/repo',
      platform: 'github',
    });

    // Should not duplicate vars/commands
    expect(result.envVars).toEqual({ KEY: 'val' });
    expect(result.setupCommands).toEqual(['cmd']);
  });

  test('handles secret vars as encryptedSecrets', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'with-secrets', { isDefault: true });
    await addVar(profileId, 'PLAIN', 'plaintext');
    await addVar(profileId, 'SECRET_KEY', fakeEnvelope, true);

    const result = await mergeProfileConfiguration({ owner });

    expect(result.envVars).toEqual({ PLAIN: 'plaintext' });
    expect(result.encryptedSecrets).toEqual({
      SECRET_KEY: {
        encryptedData: 'dGVzdC1lbmNyeXB0ZWQtZGF0YQ==',
        encryptedDEK: 'dGVzdC1lbmNyeXB0ZWQtZGVr',
        algorithm: 'rsa-aes-256-gcm',
        version: 1,
      },
    });
  });

  test('merges secrets from base and override profiles (override wins)', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    const baseEnvelope = JSON.stringify({
      encryptedData: 'YmFzZS1kYXRh',
      encryptedDEK: 'YmFzZS1kZWs=',
      algorithm: 'rsa-aes-256-gcm',
      version: 1,
    });
    const overrideEnvelope = JSON.stringify({
      encryptedData: 'b3ZlcnJpZGUtZGF0YQ==',
      encryptedDEK: 'b3ZlcnJpZGUtZGVr',
      algorithm: 'rsa-aes-256-gcm',
      version: 1,
    });

    const baseProfileId = await createProfile(owner, 'base');
    await addVar(baseProfileId, 'SHARED_SECRET', baseEnvelope, true);
    await addVar(baseProfileId, 'BASE_SECRET', baseEnvelope, true);
    await bindRepo(owner, 'org/repo', 'github', baseProfileId);

    const overrideProfileId = await createProfile(owner, 'override', { isDefault: true });
    await addVar(overrideProfileId, 'SHARED_SECRET', overrideEnvelope, true);

    const result = await mergeProfileConfiguration({
      owner,
      repoFullName: 'org/repo',
      platform: 'github',
    });

    expect(result.encryptedSecrets).toEqual({
      BASE_SECRET: JSON.parse(baseEnvelope),
      SHARED_SECRET: JSON.parse(overrideEnvelope), // override wins
    });
  });

  describe('organization context', () => {
    test('org default profile takes precedence via getEffectiveDefaultProfileId', async () => {
      const user = await insertTestUser();
      const org = await createTestOrganization('test-org', user.id, 0);
      const orgOwner: ProfileOwner = { type: 'organization', id: org.id };
      const userOwner: ProfileOwner = { type: 'user', id: user.id };

      // Personal default
      const personalProfileId = await createProfile(userOwner, 'personal-default', {
        isDefault: true,
      });
      await addVar(personalProfileId, 'SOURCE', 'personal');

      // Org default
      const orgProfileId = await createProfile(orgOwner, 'org-default', { isDefault: true });
      await addVar(orgProfileId, 'SOURCE', 'org');

      const result = await mergeProfileConfiguration({
        owner: orgOwner,
        userId: user.id,
      });

      // Org default wins
      expect(result.envVars).toEqual({ SOURCE: 'org' });
    });

    test('falls back to personal default when org has no default', async () => {
      const user = await insertTestUser();
      const org = await createTestOrganization('test-org', user.id, 0);
      const orgOwner: ProfileOwner = { type: 'organization', id: org.id };
      const userOwner: ProfileOwner = { type: 'user', id: user.id };

      // Personal default only
      const personalProfileId = await createProfile(userOwner, 'personal-default', {
        isDefault: true,
      });
      await addVar(personalProfileId, 'SOURCE', 'personal');

      const result = await mergeProfileConfiguration({
        owner: orgOwner,
        userId: user.id,
      });

      expect(result.envVars).toEqual({ SOURCE: 'personal' });
    });

    test('named profile resolves from org first, then falls back to personal', async () => {
      const user = await insertTestUser();
      const org = await createTestOrganization('test-org', user.id, 0);
      const orgOwner: ProfileOwner = { type: 'organization', id: org.id };
      const userOwner: ProfileOwner = { type: 'user', id: user.id };

      // Only exists as a personal profile
      const personalProfileId = await createProfile(userOwner, 'my-profile');
      await addVar(personalProfileId, 'SOURCE', 'personal');

      const result = await mergeProfileConfiguration({
        owner: orgOwner,
        userId: user.id,
        profileName: 'my-profile',
      });

      expect(result.envVars).toEqual({ SOURCE: 'personal' });
    });

    test('named profile prefers org when both org and personal have same name', async () => {
      const user = await insertTestUser();
      const org = await createTestOrganization('test-org', user.id, 0);
      const orgOwner: ProfileOwner = { type: 'organization', id: org.id };
      const userOwner: ProfileOwner = { type: 'user', id: user.id };

      await createProfile(userOwner, 'shared-name');
      const orgProfileId = await createProfile(orgOwner, 'shared-name');
      await addVar(orgProfileId, 'SOURCE', 'org');

      const result = await mergeProfileConfiguration({
        owner: orgOwner,
        userId: user.id,
        profileName: 'shared-name',
      });

      expect(result.envVars).toEqual({ SOURCE: 'org' });
    });
  });

  test('no repo binding when repoFullName is provided without platform', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'repo-profile');
    await addVar(profileId, 'REPO_VAR', 'bound');
    await bindRepo(owner, 'org/repo', 'github', profileId);

    // repoFullName without platform => no repo binding lookup
    const result = await mergeProfileConfiguration({
      owner,
      repoFullName: 'org/repo',
    });

    // Should not apply repo binding vars
    expect(result.envVars).toBeUndefined();
  });

  test('returns undefined for empty envVars after merge', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'commands-only', { isDefault: true });
    await addCommands(profileId, ['setup.sh']);

    const result = await mergeProfileConfiguration({ owner });

    expect(result.envVars).toBeUndefined();
    expect(result.setupCommands).toEqual(['setup.sh']);
  });
});

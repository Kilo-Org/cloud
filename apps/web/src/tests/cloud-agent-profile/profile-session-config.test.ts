/**
 * Integration test for `mergeProfileConfiguration` from
 * `@kilocode/cloud-agent-profile`, exercised against the web Postgres test
 * harness because that's where the Drizzle migrations, seed helpers, and
 * Jest setup already live.
 */
import { db } from '@/lib/drizzle';
import {
  agent_environment_profiles,
  agent_environment_profile_vars,
  agent_environment_profile_commands,
  agent_environment_profile_repo_bindings,
  agent_environment_profile_mcp_servers,
  agent_environment_profile_skills,
  agent_environment_profile_agents,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import {
  mergeProfileConfiguration,
  ProfileNotFoundError,
  profileMcpServersToClientRecord,
  type ProfileOwner,
} from '@kilocode/cloud-agent-profile';

// A valid encrypted envelope JSON that satisfies the zod schema
const fakeEnvelope = JSON.stringify({
  encryptedData: 'dGVzdC1lbmNyeXB0ZWQtZGF0YQ==',
  encryptedDEK: 'dGVzdC1lbmNyeXB0ZWQtZGVr',
  algorithm: 'rsa-aes-256-gcm',
  version: 1,
});

const fakeEnvelopeObject = {
  encryptedData: 'dGVzdC1lbmNyeXB0ZWQtZGF0YQ==',
  encryptedDEK: 'dGVzdC1lbmNyeXB0ZWQtZGVr',
  algorithm: 'rsa-aes-256-gcm' as const,
  version: 1 as const,
};

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

async function addMcpLocal(
  profileId: string,
  name: string,
  command: string[],
  opts: {
    enabled?: boolean;
    /**
     * Stored env values keyed by env var name. Each value is either a plain
     * string (for non-secret config) or an encrypted envelope (for secrets).
     */
    environment?: Record<string, string | typeof fakeEnvelopeObject>;
  } = {}
): Promise<string> {
  const [server] = await db
    .insert(agent_environment_profile_mcp_servers)
    .values({
      profile_id: profileId,
      name,
      type: 'local',
      enabled: opts.enabled ?? true,
      config: { command, environment: opts.environment },
    })
    .returning({ id: agent_environment_profile_mcp_servers.id });

  return server.id;
}

async function addSkill(
  profileId: string,
  name: string,
  rawMarkdown: string,
  opts: { enabled?: boolean } = {}
): Promise<void> {
  await db.insert(agent_environment_profile_skills).values({
    profile_id: profileId,
    name,
    source_type: 'custom',
    raw_markdown: rawMarkdown,
    enabled: opts.enabled ?? true,
  });
}

async function addAgent(
  profileId: string,
  slug: string,
  name: string,
  prompt: string
): Promise<void> {
  await db.insert(agent_environment_profile_agents).values({
    profile_id: profileId,
    slug,
    name,
    config: { prompt },
  });
}

describe('mergeProfileConfiguration', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(agent_environment_profile_repo_bindings);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(agent_environment_profile_mcp_servers);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(agent_environment_profile_skills);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(agent_environment_profile_agents);
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

    const result = await mergeProfileConfiguration(db, { owner });

    expect(result).toEqual({
      envVars: undefined,
      setupCommands: undefined,
      encryptedSecrets: undefined,
    });
  });

  test('passes through manual envVars only', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    const result = await mergeProfileConfiguration(db, {
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

    const result = await mergeProfileConfiguration(db, {
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

    const result = await mergeProfileConfiguration(db, { owner });

    expect(result.envVars).toEqual({ DB_HOST: 'localhost' });
    expect(result.setupCommands).toEqual(['echo hello']);
  });

  test('loads profile by id', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'staging');
    await addVar(profileId, 'ENV', 'staging');
    await addCommands(profileId, ['setup.sh']);

    const result = await mergeProfileConfiguration(db, {
      owner,
      profileId,
    });

    expect(result.envVars).toEqual({ ENV: 'staging' });
    expect(result.setupCommands).toEqual(['setup.sh']);
  });

  test('throws ProfileNotFoundError for unknown profile id', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const unknownId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';

    await expect(mergeProfileConfiguration(db, { owner, profileId: unknownId })).rejects.toThrow(
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

    const result = await mergeProfileConfiguration(db, {
      owner,
      repoFullName: 'org/repo',
      platform: 'github',
    });

    expect(result.envVars).toEqual({ REPO_VAR: 'bound' });
    expect(result.setupCommands).toEqual(['repo-setup']);
  });

  test('merges repo binding (base) with explicit override and manual args', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    // Base: repo binding profile
    const baseProfileId = await createProfile(owner, 'base-profile');
    await addVar(baseProfileId, 'SHARED', 'from-base');
    await addVar(baseProfileId, 'BASE_ONLY', 'base-val');
    await addCommands(baseProfileId, ['base-cmd']);
    await bindRepo(owner, 'org/repo', 'github', baseProfileId);

    // Override: explicitly picked by the caller
    const overrideProfileId = await createProfile(owner, 'override-profile');
    await addVar(overrideProfileId, 'SHARED', 'from-override');
    await addVar(overrideProfileId, 'OVERRIDE_ONLY', 'override-val');
    await addCommands(overrideProfileId, ['override-cmd']);

    const result = await mergeProfileConfiguration(db, {
      owner,
      profileId: overrideProfileId,
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

  test('repo binding (base) and effective default (top) are co-applied; default wins on collision', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    const repoProfileId = await createProfile(owner, 'repo-profile');
    await addVar(repoProfileId, 'FROM', 'repo');
    await addVar(repoProfileId, 'REPO_ONLY', 'repo-val');
    await bindRepo(owner, 'org/repo', 'github', repoProfileId);

    // Default layers on top of the repo binding.
    const defaultProfileId = await createProfile(owner, 'default-profile', { isDefault: true });
    await addVar(defaultProfileId, 'FROM', 'default');
    await addVar(defaultProfileId, 'DEFAULT_ONLY', 'default-val');

    const result = await mergeProfileConfiguration(db, {
      owner,
      repoFullName: 'org/repo',
      platform: 'github',
    });

    expect(result.envVars).toEqual({
      REPO_ONLY: 'repo-val',
      DEFAULT_ONLY: 'default-val',
      FROM: 'default',
    });
  });

  test('explicit pick suppresses the default (default is only a fallback)', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    const defaultProfileId = await createProfile(owner, 'default-profile', { isDefault: true });
    await addVar(defaultProfileId, 'FROM', 'default');

    const pickedProfileId = await createProfile(owner, 'picked-profile');
    await addVar(pickedProfileId, 'FROM', 'picked');

    const result = await mergeProfileConfiguration(db, { owner, profileId: pickedProfileId });

    expect(result.envVars).toEqual({ FROM: 'picked' });
  });

  test('deduplicates when explicit override equals the repo binding', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'shared-profile');
    await addVar(profileId, 'KEY', 'val');
    await addCommands(profileId, ['cmd']);
    await bindRepo(owner, 'org/repo', 'github', profileId);

    const result = await mergeProfileConfiguration(db, {
      owner,
      profileId,
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

    const result = await mergeProfileConfiguration(db, { owner });

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

    const overrideProfileId = await createProfile(owner, 'override');
    await addVar(overrideProfileId, 'SHARED_SECRET', overrideEnvelope, true);

    const result = await mergeProfileConfiguration(db, {
      owner,
      profileId: overrideProfileId,
      repoFullName: 'org/repo',
      platform: 'github',
    });

    expect(result.encryptedSecrets).toEqual({
      BASE_SECRET: JSON.parse(baseEnvelope),
      SHARED_SECRET: JSON.parse(overrideEnvelope), // override wins
    });
  });

  describe('organization context', () => {
    test('personal default profile takes precedence via getEffectiveDefaultProfileId', async () => {
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

      const result = await mergeProfileConfiguration(db, {
        owner: orgOwner,
        userId: user.id,
      });

      // Personal default wins — user-specific preference overrides org baseline
      expect(result.envVars).toEqual({ SOURCE: 'personal' });
    });

    test('falls back to org default when user has no personal default', async () => {
      const user = await insertTestUser();
      const org = await createTestOrganization('test-org', user.id, 0);
      const orgOwner: ProfileOwner = { type: 'organization', id: org.id };

      // Org default only
      const orgProfileId = await createProfile(orgOwner, 'org-default', { isDefault: true });
      await addVar(orgProfileId, 'SOURCE', 'org');

      const result = await mergeProfileConfiguration(db, {
        owner: orgOwner,
        userId: user.id,
      });

      expect(result.envVars).toEqual({ SOURCE: 'org' });
    });

    test('member can select a personal profile in org context via profileId', async () => {
      const user = await insertTestUser();
      const org = await createTestOrganization('test-org', user.id, 0);
      const orgOwner: ProfileOwner = { type: 'organization', id: org.id };
      const userOwner: ProfileOwner = { type: 'user', id: user.id };

      const personalProfileId = await createProfile(userOwner, 'my-profile');
      await addVar(personalProfileId, 'SOURCE', 'personal');

      const result = await mergeProfileConfiguration(db, {
        owner: orgOwner,
        userId: user.id,
        profileId: personalProfileId,
      });

      expect(result.envVars).toEqual({ SOURCE: 'personal' });
    });

    test('member can select an org profile in org context via profileId', async () => {
      const user = await insertTestUser();
      const org = await createTestOrganization('test-org', user.id, 0);
      const orgOwner: ProfileOwner = { type: 'organization', id: org.id };

      const orgProfileId = await createProfile(orgOwner, 'shared-name');
      await addVar(orgProfileId, 'SOURCE', 'org');

      const result = await mergeProfileConfiguration(db, {
        owner: orgOwner,
        userId: user.id,
        profileId: orgProfileId,
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
    const result = await mergeProfileConfiguration(db, {
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

    const result = await mergeProfileConfiguration(db, { owner });

    expect(result.envVars).toBeUndefined();
    expect(result.setupCommands).toEqual(['setup.sh']);
  });

  test('resolves profile by profileId', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'by-id');
    await addVar(profileId, 'KEY', 'value');

    const result = await mergeProfileConfiguration(db, { owner, profileId });

    expect(result.envVars).toEqual({ KEY: 'value' });
  });

  test('throws ProfileNotFoundError when profileId is not owned by the caller', async () => {
    const user = await insertTestUser();
    const other = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const otherProfileId = await createProfile({ type: 'user', id: other.id }, 'others');

    await expect(
      mergeProfileConfiguration(db, { owner, profileId: otherProfileId })
    ).rejects.toThrow(ProfileNotFoundError);
  });

  test('includes MCP servers from the selected profile with encrypted env values', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'with-mcp', { isDefault: true });
    await addMcpLocal(profileId, 'demo', ['node', 'server.js'], {
      environment: { PORT: fakeEnvelopeObject },
    });

    const result = await mergeProfileConfiguration(db, { owner });

    expect(result.mcpServers).toHaveLength(1);
    const [server] = result.mcpServers ?? [];
    expect(server).toMatchObject({
      name: 'demo',
      type: 'local',
      enabled: true,
      command: ['node', 'server.js'],
    });
    expect(server?.environment?.PORT).toMatchObject({ algorithm: 'rsa-aes-256-gcm', version: 1 });
  });

  test('omits disabled MCP servers from merged result', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'with-disabled', { isDefault: true });
    await addMcpLocal(profileId, 'off', ['node', 'off.js'], { enabled: false });

    const result = await mergeProfileConfiguration(db, { owner });

    expect(result.mcpServers).toBeUndefined();
  });

  test('merges MCP servers across profile layers — later wins by name', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    const baseProfileId = await createProfile(owner, 'base');
    await addMcpLocal(baseProfileId, 'shared', ['node', 'base.js']);
    await addMcpLocal(baseProfileId, 'base-only', ['node', 'base-only.js']);
    await bindRepo(owner, 'org/repo', 'github', baseProfileId);

    const overrideId = await createProfile(owner, 'override');
    await addMcpLocal(overrideId, 'shared', ['node', 'override.js']);
    await addMcpLocal(overrideId, 'override-only', ['node', 'override-only.js']);

    const result = await mergeProfileConfiguration(db, {
      owner,
      profileId: overrideId,
      repoFullName: 'org/repo',
      platform: 'github',
    });

    expect(result.mcpServers?.map(s => s.name).sort()).toEqual([
      'base-only',
      'override-only',
      'shared',
    ]);
    const shared = result.mcpServers?.find(s => s.name === 'shared');
    expect(shared).toMatchObject({ type: 'local', command: ['node', 'override.js'] });
  });

  test('includes only enabled skills, merged by name across profile layers', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    const baseProfileId = await createProfile(owner, 'base');
    await addSkill(baseProfileId, 'alpha', '---\nname: alpha\n---\nbase body');
    await addSkill(baseProfileId, 'disabled', '---\nname: disabled\n---\nbody', { enabled: false });
    await bindRepo(owner, 'org/repo', 'github', baseProfileId);

    const overrideId = await createProfile(owner, 'override');
    await addSkill(overrideId, 'alpha', '---\nname: alpha\n---\noverride body');
    await addSkill(overrideId, 'beta', '---\nname: beta\n---\nbody');

    const result = await mergeProfileConfiguration(db, {
      owner,
      profileId: overrideId,
      repoFullName: 'org/repo',
      platform: 'github',
    });

    expect(result.skills?.map(s => s.name).sort()).toEqual(['alpha', 'beta']);
    expect(result.skills?.find(s => s.name === 'alpha')?.rawMarkdown).toContain('override body');
  });

  test('MCP env values travel as encrypted envelopes in the client record', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'with-secrets', { isDefault: true });
    await addMcpLocal(profileId, 'demo', ['node', 'server.js'], {
      environment: { API_KEY: fakeEnvelopeObject },
    });

    const result = await mergeProfileConfiguration(db, { owner });
    const record = profileMcpServersToClientRecord(result.mcpServers);

    expect(record).toBeDefined();
    const demo = record?.demo;
    expect(demo).toBeDefined();
    if (demo && demo.type === 'local') {
      expect(demo.environment).toBeDefined();
      expect(demo.environment?.API_KEY).toMatchObject({
        algorithm: 'rsa-aes-256-gcm',
        version: 1,
      });
    } else {
      throw new Error('Expected local MCP server in record');
    }
  });

  test('plain-string MCP env values round-trip through the client record verbatim', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'with-mixed', { isDefault: true });
    await addMcpLocal(profileId, 'demo', ['node', 'server.js'], {
      environment: { LOCALE: 'en-US', API_KEY: fakeEnvelopeObject },
    });

    const result = await mergeProfileConfiguration(db, { owner });
    const record = profileMcpServersToClientRecord(result.mcpServers);

    const demo = record?.demo;
    if (demo && demo.type === 'local') {
      expect(demo.environment?.LOCALE).toBe('en-US');
      expect(demo.environment?.API_KEY).toMatchObject({
        algorithm: 'rsa-aes-256-gcm',
        version: 1,
      });
    } else {
      throw new Error('Expected local MCP server in record');
    }
  });

  describe('inline layer', () => {
    test('inline mcpServers layer on top of profile — inline wins on name', async () => {
      const user = await insertTestUser();
      const owner: ProfileOwner = { type: 'user', id: user.id };
      const profileId = await createProfile(owner, 'with-mcp', { isDefault: true });
      await addMcpLocal(profileId, 'shared', ['node', 'profile.js']);
      await addMcpLocal(profileId, 'profile-only', ['node', 'profile-only.js']);

      const result = await mergeProfileConfiguration(db, {
        owner,
        mcpServers: {
          shared: { type: 'local', command: ['node', 'inline.js'] },
          'inline-only': { type: 'local', command: ['node', 'inline-only.js'] },
        },
      });

      expect(result.mcpServers?.map(s => s.name).sort()).toEqual([
        'inline-only',
        'profile-only',
        'shared',
      ]);
      const shared = result.mcpServers?.find(s => s.name === 'shared');
      expect(shared).toMatchObject({ type: 'local', command: ['node', 'inline.js'] });
    });

    test('disabled inline MCP server does not shadow an enabled profile entry', async () => {
      const user = await insertTestUser();
      const owner: ProfileOwner = { type: 'user', id: user.id };
      const profileId = await createProfile(owner, 'with-mcp', { isDefault: true });
      await addMcpLocal(profileId, 'demo', ['node', 'profile.js']);

      const result = await mergeProfileConfiguration(db, {
        owner,
        mcpServers: {
          demo: { type: 'local', command: ['node', 'inline.js'], enabled: false },
        },
      });

      // Profile's enabled `demo` survives — disabled inline entries are skipped, not delete-keys.
      const demo = result.mcpServers?.find(s => s.name === 'demo');
      expect(demo).toMatchObject({ type: 'local', command: ['node', 'profile.js'] });
    });

    test('inline runtimeSkills layer on top of profile — inline wins on name', async () => {
      const user = await insertTestUser();
      const owner: ProfileOwner = { type: 'user', id: user.id };
      const profileId = await createProfile(owner, 'with-skills', { isDefault: true });
      await addSkill(profileId, 'shared', '---\nname: shared\n---\nprofile body');
      await addSkill(profileId, 'profile-only', '---\nname: profile-only\n---\nbody');

      const result = await mergeProfileConfiguration(db, {
        owner,
        runtimeSkills: [
          { name: 'shared', rawMarkdown: 'inline body for shared' },
          { name: 'inline-only', rawMarkdown: 'inline-only body', files: { 'a.md': 'a' } },
        ],
      });

      expect(result.skills?.map(s => s.name).sort()).toEqual([
        'inline-only',
        'profile-only',
        'shared',
      ]);
      expect(result.skills?.find(s => s.name === 'shared')?.rawMarkdown).toBe(
        'inline body for shared'
      );
      expect(result.skills?.find(s => s.name === 'inline-only')?.files).toEqual({ 'a.md': 'a' });
    });

    test('inline runtimeAgents layer on top of profile — inline wins on slug', async () => {
      const user = await insertTestUser();
      const owner: ProfileOwner = { type: 'user', id: user.id };
      const profileId = await createProfile(owner, 'with-agents', { isDefault: true });
      await addAgent(profileId, 'reviewer', 'Reviewer', 'profile reviewer prompt');
      await addAgent(profileId, 'profile-only', 'Profile Only', 'profile-only prompt');

      const result = await mergeProfileConfiguration(db, {
        owner,
        runtimeAgents: [
          { slug: 'reviewer', name: 'Reviewer', config: { prompt: 'inline reviewer prompt' } },
          { slug: 'inline-only', name: 'Inline Only', config: { prompt: 'inline-only prompt' } },
        ],
      });

      expect(result.agents?.map(a => a.slug).sort()).toEqual([
        'inline-only',
        'profile-only',
        'reviewer',
      ]);
      expect(result.agents?.find(a => a.slug === 'reviewer')?.config.prompt).toBe(
        'inline reviewer prompt'
      );
    });

    test('inline encryptedSecrets layer on top of profile — inline wins on key', async () => {
      const user = await insertTestUser();
      const owner: ProfileOwner = { type: 'user', id: user.id };
      const profileId = await createProfile(owner, 'with-secrets', { isDefault: true });
      await addVar(profileId, 'API_KEY', fakeEnvelope, true);

      const inlineEnvelope = {
        encryptedData: 'aW5saW5lLWRhdGE=',
        encryptedDEK: 'aW5saW5lLWRlaw==',
        algorithm: 'rsa-aes-256-gcm' as const,
        version: 1 as const,
      };

      const result = await mergeProfileConfiguration(db, {
        owner,
        encryptedSecrets: { API_KEY: inlineEnvelope, INLINE_ONLY: inlineEnvelope },
      });

      expect(result.encryptedSecrets).toEqual({
        API_KEY: inlineEnvelope, // inline wins over profile envelope
        INLINE_ONLY: inlineEnvelope,
      });
    });
  });
});

import { db } from '@/lib/drizzle';
import {
  agent_environment_profiles,
  agent_environment_profile_vars,
  agent_environment_profile_commands,
  agent_environment_profile_repo_bindings,
  platform_integrations,
  type PlatformIntegration,
} from '@kilocode/db/schema';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { resolveBotSessionProfile } from './resolve-bot-session-profile';
import { ownerFromIntegration } from '@/lib/integrations/core/owner';
import type { ProfileOwner } from '@/lib/agent/types';

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

async function insertPlatformIntegration(opts: {
  organizationId?: string;
  userId?: string;
  platform: 'github' | 'gitlab';
}): Promise<PlatformIntegration> {
  const [row] = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: opts.organizationId ?? null,
      owned_by_user_id: opts.userId ?? null,
      platform: opts.platform,
      integration_type: opts.platform === 'github' ? 'app' : 'oauth',
    })
    .returning();
  return row;
}

describe('resolveBotSessionProfile', () => {
  afterEach(async () => {
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(agent_environment_profile_repo_bindings);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(agent_environment_profile_commands);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(agent_environment_profile_vars);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(agent_environment_profiles);
    // eslint-disable-next-line drizzle/enforce-delete-with-where
    await db.delete(platform_integrations);
  });

  test('returns empty config when owner has no default profile and no repo binding', async () => {
    const user = await insertTestUser();
    const integration = await insertPlatformIntegration({ userId: user.id, platform: 'github' });

    const result = await resolveBotSessionProfile(ownerFromIntegration(integration), user.id, {
      githubRepo: 'org/repo',
    });

    expect(result.envVars).toBeUndefined();
    expect(result.encryptedSecrets).toBeUndefined();
    expect(result.setupCommands).toBeUndefined();
  });

  test('user-owned integration: applies user default profile', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };
    const profileId = await createProfile(owner, 'personal-default', { isDefault: true });
    await addVar(profileId, 'DB_HOST', 'localhost');
    await addVar(profileId, 'SECRET_TOKEN', fakeEnvelope, true);
    await addCommands(profileId, ['npm install']);

    const integration = await insertPlatformIntegration({ userId: user.id, platform: 'github' });

    const result = await resolveBotSessionProfile(ownerFromIntegration(integration), user.id, {
      githubRepo: 'org/repo',
    });

    expect(result.envVars).toEqual({ DB_HOST: 'localhost' });
    expect(result.setupCommands).toEqual(['npm install']);
    expect(result.encryptedSecrets).toEqual({
      SECRET_TOKEN: {
        encryptedData: 'dGVzdC1lbmNyeXB0ZWQtZGF0YQ==',
        encryptedDEK: 'dGVzdC1lbmNyeXB0ZWQtZGVr',
        algorithm: 'rsa-aes-256-gcm',
        version: 1,
      },
    });
  });

  test('org-owned integration: effective default falls back to ticket user personal default', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('test-org', user.id, 0);
    const userOwner: ProfileOwner = { type: 'user', id: user.id };

    const personalProfileId = await createProfile(userOwner, 'personal-default', {
      isDefault: true,
    });
    await addVar(personalProfileId, 'SOURCE', 'personal');

    const integration = await insertPlatformIntegration({
      organizationId: org.id,
      platform: 'github',
    });

    const result = await resolveBotSessionProfile(ownerFromIntegration(integration), user.id, {
      githubRepo: 'org/repo',
    });

    expect(result.envVars).toEqual({ SOURCE: 'personal' });
  });

  test('org-owned integration: org default takes precedence over user personal default', async () => {
    const user = await insertTestUser();
    const org = await createTestOrganization('test-org', user.id, 0);
    const userOwner: ProfileOwner = { type: 'user', id: user.id };
    const orgOwner: ProfileOwner = { type: 'organization', id: org.id };

    const personalProfileId = await createProfile(userOwner, 'personal-default', {
      isDefault: true,
    });
    await addVar(personalProfileId, 'SOURCE', 'personal');

    const orgProfileId = await createProfile(orgOwner, 'org-default', { isDefault: true });
    await addVar(orgProfileId, 'SOURCE', 'org');

    const integration = await insertPlatformIntegration({
      organizationId: org.id,
      platform: 'github',
    });

    const result = await resolveBotSessionProfile(ownerFromIntegration(integration), user.id, {
      githubRepo: 'org/repo',
    });

    expect(result.envVars).toEqual({ SOURCE: 'org' });
  });

  test('layers repo-binding profile (base) under default profile (override)', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    const baseProfileId = await createProfile(owner, 'base');
    await addVar(baseProfileId, 'SHARED', 'from-base');
    await addVar(baseProfileId, 'BASE_ONLY', 'base-val');
    await addCommands(baseProfileId, ['base-cmd']);
    await bindRepo(owner, 'org/repo', 'github', baseProfileId);

    const overrideProfileId = await createProfile(owner, 'override', { isDefault: true });
    await addVar(overrideProfileId, 'SHARED', 'from-override');
    await addVar(overrideProfileId, 'OVERRIDE_ONLY', 'override-val');
    await addCommands(overrideProfileId, ['override-cmd']);

    const integration = await insertPlatformIntegration({ userId: user.id, platform: 'github' });

    const result = await resolveBotSessionProfile(ownerFromIntegration(integration), user.id, {
      githubRepo: 'org/repo',
    });

    expect(result.envVars).toEqual({
      BASE_ONLY: 'base-val',
      OVERRIDE_ONLY: 'override-val',
      SHARED: 'from-override',
    });
    expect(result.setupCommands).toEqual(['base-cmd', 'override-cmd']);
  });

  test('gitlabProject: uses platform=gitlab when resolving repo binding', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    const gitlabProfileId = await createProfile(owner, 'gitlab-bound');
    await addVar(gitlabProfileId, 'FOR', 'gitlab');
    await bindRepo(owner, 'group/project', 'gitlab', gitlabProfileId);

    const githubProfileId = await createProfile(owner, 'github-bound');
    await addVar(githubProfileId, 'FOR', 'github');
    await bindRepo(owner, 'group/project', 'github', githubProfileId);

    const integration = await insertPlatformIntegration({ userId: user.id, platform: 'gitlab' });

    const result = await resolveBotSessionProfile(ownerFromIntegration(integration), user.id, {
      gitlabProject: 'group/project',
    });

    expect(result.envVars).toEqual({ FOR: 'gitlab' });
  });

  test('repo binding is scoped by owner: no binding for requested repo => default only', async () => {
    const user = await insertTestUser();
    const owner: ProfileOwner = { type: 'user', id: user.id };

    const defaultProfileId = await createProfile(owner, 'default', { isDefault: true });
    await addVar(defaultProfileId, 'FROM', 'default');

    const otherProfileId = await createProfile(owner, 'other');
    await addVar(otherProfileId, 'FROM', 'binding');
    await bindRepo(owner, 'other/repo', 'github', otherProfileId);

    const integration = await insertPlatformIntegration({ userId: user.id, platform: 'github' });

    const result = await resolveBotSessionProfile(ownerFromIntegration(integration), user.id, {
      githubRepo: 'org/repo',
    });

    expect(result.envVars).toEqual({ FROM: 'default' });
  });
});

import { generateKeyPairSync } from 'node:crypto';
import { describe, test, expect, afterEach } from '@jest/globals';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  agent_environment_profiles,
  cloud_agent_repository_environment_defaults,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  createEnvironment,
  deleteEnvironment,
  getRepositoryEnvironmentDefault,
  getRepositoryEnvironmentDefaults,
  loadEnvironmentForSession,
  removeRepositorySettings,
  setRepositorySettings,
  updateEnvironment,
  type EnvironmentCreateInput,
  type EnvironmentOwner,
  type ProfileOwner,
} from '@kilocode/cloud-agent-profile';

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyBase64 = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString(
  'base64'
);

function userOwner(id: string): EnvironmentOwner {
  return { type: 'user', id };
}

async function createEnv(input: EnvironmentCreateInput): Promise<string> {
  return db.transaction(async tx => (await createEnvironment(tx, publicKeyBase64, input)).id);
}

async function insertProfile(owner: ProfileOwner, name: string): Promise<string> {
  const [row] = await db
    .insert(agent_environment_profiles)
    .values({
      ...(owner.type === 'user'
        ? { owned_by_user_id: owner.id }
        : { owned_by_organization_id: owner.id }),
      name,
    })
    .returning({ id: agent_environment_profiles.id });
  return row.id;
}

async function updateEnvRepositories(
  owner: EnvironmentOwner,
  environmentId: string,
  repositories: Array<{ platform: 'github'; repoFullName: string }>
): Promise<void> {
  await db.transaction(async tx => {
    await updateEnvironment(tx, publicKeyBase64, { owner, environmentId, repositories });
  });
}

async function storedDefaultRows(owner: EnvironmentOwner) {
  return db
    .select()
    .from(cloud_agent_repository_environment_defaults)
    .where(
      owner.type === 'user'
        ? eq(cloud_agent_repository_environment_defaults.owned_by_user_id, owner.id)
        : eq(cloud_agent_repository_environment_defaults.owned_by_organization_id, owner.id)
    );
}

describe('repository environment defaults', () => {
  afterEach(cleanupDbForTest);

  describe('storage and settings', () => {
    test('stores a canonical owner-scoped default independently of the bound profile', async () => {
      const user = await insertTestUser();
      const other = await insertTestUser();
      const owner = userOwner(user.id);
      const profileId = await insertProfile(owner, 'Personal');
      const environmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'Acme/Widgets',
      });
      const otherEnvironmentId = await createEnv({
        owner: userOwner(other.id),
        createdByUserId: other.id,
        name: 'Other',
        platform: 'github',
        repoFullName: 'Acme/Widgets',
      });

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'Acme/Widgets' },
        {
          profileId,
          environment: { mode: 'environment', environmentId },
        }
      );
      await setRepositorySettings(
        db,
        userOwner(other.id),
        { platform: 'github', repoFullName: 'Acme/Widgets' },
        {
          environment: { mode: 'environment', environmentId: otherEnvironmentId },
        }
      );

      await expect(getRepositoryEnvironmentDefaults(db, owner)).resolves.toEqual([
        {
          repositoryFullName: 'acme/widgets',
          repositoryPlatform: 'github',
          repositoryKey: 'acme/widgets',
          environment: { mode: 'environment', environmentId },
        },
      ]);
      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'github',
          repoFullName: 'ACME/WIDGETS',
        })
      ).resolves.toEqual({ mode: 'environment', environmentId });
      await expect(
        getRepositoryEnvironmentDefault(db, userOwner(other.id), {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'environment', environmentId: otherEnvironmentId });
      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'github',
          repoFullName: 'acme/other',
        })
      ).resolves.toEqual({ mode: 'automatic' });
    });

    test('scopes organization defaults separately from personal defaults', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Defaults org', user.id, 0);
      const personalOwner = userOwner(user.id);
      const organizationOwner: EnvironmentOwner = {
        type: 'organization',
        id: organization.id,
      };
      const personalEnvironmentId = await createEnv({
        owner: personalOwner,
        createdByUserId: user.id,
        name: 'Personal',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      const organizationEnvironmentId = await createEnv({
        owner: organizationOwner,
        createdByUserId: user.id,
        name: 'Shared',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      await setRepositorySettings(
        db,
        personalOwner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'environment', environmentId: personalEnvironmentId },
        }
      );
      await setRepositorySettings(
        db,
        organizationOwner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'environment', environmentId: organizationEnvironmentId },
        }
      );

      await expect(
        getRepositoryEnvironmentDefault(db, personalOwner, {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'environment', environmentId: personalEnvironmentId });
      await expect(
        getRepositoryEnvironmentDefault(db, organizationOwner, {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'environment', environmentId: organizationEnvironmentId });
    });

    test('preserves an omitted default while profile and allocation change', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const profileId = await insertProfile(owner, 'Personal');
      const environmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'environment', environmentId },
          profileId,
          allocation: 'cloudflare-shared',
        }
      );

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          profileId,
          allocation: 'cloudflare-containers-standard-4',
        }
      );
      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'environment', environmentId });

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          profileId,
        }
      );
      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'environment', environmentId });
    });

    test('removes the default when automatic is selected with the other halves preserved', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const profileId = await insertProfile(owner, 'Personal');
      const environmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'environment', environmentId },
          profileId,
          allocation: 'cloudflare-shared',
        }
      );
      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'automatic' },
          profileId,
          allocation: 'cloudflare-shared',
        }
      );

      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'automatic' });
      await expect(getRepositoryEnvironmentDefaults(db, owner)).resolves.toEqual([]);
      await expect(storedDefaultRows(owner)).resolves.toEqual([]);
    });

    test('removing all repository settings clears the default, allocation and binding', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const profileId = await insertProfile(owner, 'Personal');
      const environmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'environment', environmentId },
          profileId,
          allocation: 'cloudflare-shared',
        }
      );
      await removeRepositorySettings(db, owner, {
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      await expect(getRepositoryEnvironmentDefaults(db, owner)).resolves.toEqual([]);
    });

    test('stores none without an environment and switches to named and automatic', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const environmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'none' },
        }
      );
      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'none' });
      await expect(getRepositoryEnvironmentDefaults(db, owner)).resolves.toEqual([
        {
          repositoryFullName: 'acme/widgets',
          repositoryPlatform: 'github',
          repositoryKey: 'acme/widgets',
          environment: { mode: 'none' },
        },
      ]);
      const [storedNone] = await storedDefaultRows(owner);
      expect(storedNone.environment_id).toBeNull();

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'environment', environmentId },
        }
      );
      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'environment', environmentId });

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'none' },
        }
      );
      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'none' });

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'automatic' },
        }
      );
      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'automatic' });
      await expect(getRepositoryEnvironmentDefaults(db, owner)).resolves.toEqual([]);
      await expect(storedDefaultRows(owner)).resolves.toEqual([]);
    });

    test('scopes a none default to its owner', async () => {
      const user = await insertTestUser();
      const other = await insertTestUser();
      const organization = await createTestOrganization('None org', user.id, 0);
      const owner = userOwner(user.id);
      const organizationOwner: ProfileOwner = { type: 'organization', id: organization.id };

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'none' },
        }
      );
      await setRepositorySettings(
        db,
        organizationOwner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'none' },
        }
      );

      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'none' });
      await expect(
        getRepositoryEnvironmentDefault(db, organizationOwner, {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'none' });
      await expect(
        getRepositoryEnvironmentDefault(db, userOwner(other.id), {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'automatic' });
      await expect(getRepositoryEnvironmentDefaults(db, userOwner(other.id))).resolves.toEqual([]);
    });
  });

  describe('default validation', () => {
    test('rejects an environment owned by another owner', async () => {
      const user = await insertTestUser();
      const other = await insertTestUser();
      const environmentId = await createEnv({
        owner: userOwner(other.id),
        createdByUserId: other.id,
        name: 'Other',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      await expect(
        setRepositorySettings(
          db,
          userOwner(user.id),
          { platform: 'github', repoFullName: 'acme/widgets' },
          {
            environment: { mode: 'environment', environmentId },
          }
        )
      ).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Environment not found' });
    });

    test('rejects an environment that does not contain the repository', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const environmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'Other',
        platform: 'github',
        repoFullName: 'acme/other',
      });

      await expect(
        setRepositorySettings(
          db,
          owner,
          { platform: 'github', repoFullName: 'acme/widgets' },
          {
            environment: { mode: 'environment', environmentId },
          }
        )
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'The selected environment does not contain this repository',
      });
    });

    test('accepts a V2 environment that contains the repository', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const environmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'Multi',
        repositories: [
          { platform: 'github', repoFullName: 'Acme/Widgets' },
          { platform: 'github', repoFullName: 'Acme/Other' },
        ],
      });

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'ACME/WIDGETS' },
        {
          environment: { mode: 'environment', environmentId },
        }
      );

      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'environment', environmentId });
    });

    test('does not revalidate an unchanged stale string while editing the profile or allocation', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const profileId = await insertProfile(owner, 'Personal');
      const environmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'environment', environmentId },
          profileId,
          allocation: 'cloudflare-shared',
        }
      );
      await deleteEnvironment(db, environmentId, owner);

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'environment', environmentId },
          profileId,
          allocation: 'cloudflare-containers-standard-4',
        }
      );

      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'github',
          repoFullName: 'acme/widgets',
        })
      ).resolves.toEqual({ mode: 'environment', environmentId });
    });
  });

  describe('resolution', () => {
    test('uses the saved default when several environments contain the repository', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const singleEnvironmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'Single',
        platform: 'github',
        repoFullName: 'acme/widgets',
        commands: ['single'],
      });
      await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'Multi',
        repositories: [{ platform: 'github', repoFullName: 'acme/widgets' }],
        commands: ['multi'],
      });

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'environment', environmentId: singleEnvironmentId },
        }
      );
      const resolution = await loadEnvironmentForSession(db, {
        owner,
        repository: { platform: 'github', repoFullName: 'acme/widgets' },
      });

      expect(resolution.status).toBe('match');
      if (resolution.status !== 'match') return;
      expect(resolution.environment.reference.environmentId).toBe(singleEnvironmentId);
      expect(resolution.environment.layer.setupCommands).toEqual(['single']);
    });

    test('keeps the conflict behavior when no default is saved', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const singleEnvironmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'Single',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'Multi',
        repositories: [{ platform: 'github', repoFullName: 'acme/widgets' }],
      });

      const single = await loadEnvironmentForSession(db, {
        owner,
        repository: { platform: 'github', repoFullName: 'acme/widgets' },
      });
      expect(single.status).toBe('conflict');

      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'environment', environmentId: singleEnvironmentId },
        }
      );
      await removeRepositorySettings(db, owner, {
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      const none = await loadEnvironmentForSession(db, {
        owner,
        repository: { platform: 'github', repoFullName: 'acme/widgets' },
      });
      expect(none.status).toBe('conflict');
    });

    test('lets an explicit selection override the saved default', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const singleEnvironmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'Single',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      const multiEnvironmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'Multi',
        repositories: [{ platform: 'github', repoFullName: 'acme/widgets' }],
      });
      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'environment', environmentId: singleEnvironmentId },
        }
      );

      const resolution = await loadEnvironmentForSession(db, {
        owner,
        repository: { platform: 'github', repoFullName: 'acme/widgets' },
        environmentId: multiEnvironmentId,
      });

      expect(resolution.status).toBe('match');
      if (resolution.status !== 'match') return;
      expect(resolution.environment.reference.environmentId).toBe(multiEnvironmentId);
    });

    test('uses a saved none even when an environment contains the repository', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'none' },
        }
      );

      await expect(
        loadEnvironmentForSession(db, {
          owner,
          repository: { platform: 'github', repoFullName: 'acme/widgets' },
        })
      ).resolves.toEqual({ status: 'none' });
    });

    test('lets an explicit selection override a saved none', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const environmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'none' },
        }
      );

      const resolution = await loadEnvironmentForSession(db, {
        owner,
        repository: { platform: 'github', repoFullName: 'acme/widgets' },
        environmentId,
      });

      expect(resolution.status).toBe('match');
      if (resolution.status !== 'match') return;
      expect(resolution.environment.reference.environmentId).toBe(environmentId);
    });

    test('reports a deleted default instead of falling through to other matches', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const environmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'Multi',
        repositories: [{ platform: 'github', repoFullName: 'acme/widgets' }],
      });
      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'environment', environmentId },
        }
      );
      await deleteEnvironment(db, environmentId, owner);

      await expect(
        loadEnvironmentForSession(db, {
          owner,
          repository: { platform: 'github', repoFullName: 'acme/widgets' },
        })
      ).resolves.toEqual({ status: 'default-not-found', environmentId });
    });

    test('reports a default that no longer contains the launch repository', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const environmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      await setRepositorySettings(
        db,
        owner,
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          environment: { mode: 'environment', environmentId },
        }
      );
      await updateEnvRepositories(owner, environmentId, [
        { platform: 'github', repoFullName: 'acme/other' },
      ]);

      await expect(
        loadEnvironmentForSession(db, {
          owner,
          repository: { platform: 'github', repoFullName: 'acme/widgets' },
        })
      ).resolves.toEqual({ status: 'default-without-repository', environmentId });
    });

    test('reports a default owned by another owner as not found', async () => {
      const user = await insertTestUser();
      const other = await insertTestUser();
      const owner = userOwner(user.id);
      const foreignEnvironmentId = await createEnv({
        owner: userOwner(other.id),
        createdByUserId: other.id,
        name: 'Foreign',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      await db.insert(cloud_agent_repository_environment_defaults).values({
        owned_by_user_id: user.id,
        repository_full_name: 'acme/widgets',
        repository_platform: 'github',
        repository_key: 'acme/widgets',
        environment_id: foreignEnvironmentId,
      });

      await expect(
        loadEnvironmentForSession(db, {
          owner,
          repository: { platform: 'github', repoFullName: 'acme/widgets' },
        })
      ).resolves.toEqual({
        status: 'default-not-found',
        environmentId: foreignEnvironmentId,
      });
    });

    test('matches a GitLab default through the canonical clone URL settings key', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const environmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'GitLab',
        platform: 'gitlab',
        repoFullName: 'Group/Project',
        gitlabCloneUrl: 'https://gitlab.com/group/project.git',
        commands: ['gitlab'],
      });
      await setRepositorySettings(
        db,
        owner,
        {
          platform: 'gitlab',
          repoFullName: 'Group/Project',
          cloneUrl: 'https://gitlab.com/group/project.git',
        },
        {
          environment: { mode: 'environment', environmentId },
        }
      );

      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'gitlab',
          cloneUrl: 'https://gitlab.com/group/project.git',
        })
      ).resolves.toEqual({ mode: 'environment', environmentId });

      const resolution = await loadEnvironmentForSession(db, {
        owner,
        repository: { platform: 'gitlab', cloneUrl: 'https://gitlab.com/group/project.git' },
      });
      expect(resolution.status).toBe('match');
      if (resolution.status !== 'match') return;
      expect(resolution.environment.reference.environmentId).toBe(environmentId);
      expect(resolution.environment.layer.setupCommands).toEqual(['gitlab']);
    });

    test('resolves a GitLab default under a base path and non-default port', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const cloneUrl = 'https://git.corp:8443/gitlab/group/project.git';
      const defaultEnvironmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'Default',
        platform: 'gitlab',
        repoFullName: 'group/project',
        gitlabCloneUrl: cloneUrl,
        commands: ['default'],
      });
      await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'Other',
        repositories: [
          { platform: 'gitlab', repoFullName: 'group/project', gitlabCloneUrl: cloneUrl },
        ],
        commands: ['other'],
      });
      await setRepositorySettings(
        db,
        owner,
        { platform: 'gitlab', repoFullName: 'group/project', cloneUrl },
        { environment: { mode: 'environment', environmentId: defaultEnvironmentId } }
      );

      const resolution = await loadEnvironmentForSession(db, {
        owner,
        repository: { platform: 'gitlab', cloneUrl },
      });

      expect(resolution.status).toBe('match');
      if (resolution.status !== 'match') return;
      expect(resolution.environment.reference.environmentId).toBe(defaultEnvironmentId);
      expect(resolution.environment.layer.setupCommands).toEqual(['default']);
    });

    test('keeps the same GitLab path separate across instances, including none', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const gitlabCom = 'https://gitlab.com/acme/web.git';
      const selfHosted = 'https://git.corp:8443/gitlab/acme/web.git';
      const gitlabComEnvironmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'GitLab.com',
        platform: 'gitlab',
        repoFullName: 'acme/web',
        gitlabCloneUrl: gitlabCom,
      });
      await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'Self-hosted',
        platform: 'gitlab',
        repoFullName: 'acme/web',
        gitlabCloneUrl: selfHosted,
      });

      await setRepositorySettings(
        db,
        owner,
        { platform: 'gitlab', repoFullName: 'acme/web', cloneUrl: gitlabCom },
        { environment: { mode: 'environment', environmentId: gitlabComEnvironmentId } }
      );
      await setRepositorySettings(
        db,
        owner,
        { platform: 'gitlab', repoFullName: 'acme/web', cloneUrl: selfHosted },
        { environment: { mode: 'none' } }
      );

      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'gitlab',
          cloneUrl: gitlabCom,
        })
      ).resolves.toEqual({ mode: 'environment', environmentId: gitlabComEnvironmentId });
      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'gitlab',
          cloneUrl: selfHosted,
        })
      ).resolves.toEqual({ mode: 'none' });

      const gitlabComResolution = await loadEnvironmentForSession(db, {
        owner,
        repository: { platform: 'gitlab', cloneUrl: gitlabCom },
      });
      expect(gitlabComResolution.status).toBe('match');
      if (gitlabComResolution.status !== 'match') return;
      expect(gitlabComResolution.environment.reference.environmentId).toBe(gitlabComEnvironmentId);

      await expect(
        loadEnvironmentForSession(db, {
          owner,
          repository: { platform: 'gitlab', cloneUrl: selfHosted },
        })
      ).resolves.toEqual({ status: 'none' });
    });

    test('rejects a GitLab default selected for a repository on another instance', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const environmentId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'GitLab.com',
        platform: 'gitlab',
        repoFullName: 'acme/web',
        gitlabCloneUrl: 'https://gitlab.com/acme/web.git',
      });

      await expect(
        setRepositorySettings(
          db,
          owner,
          {
            platform: 'gitlab',
            repoFullName: 'acme/web',
            cloneUrl: 'https://git.corp:8443/gitlab/acme/web.git',
          },
          { environment: { mode: 'environment', environmentId } }
        )
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: 'The selected environment does not contain this repository',
      });
      await expect(
        getRepositoryEnvironmentDefault(db, owner, {
          platform: 'gitlab',
          cloneUrl: 'https://git.corp:8443/gitlab/acme/web.git',
        })
      ).resolves.toEqual({ mode: 'automatic' });
    });
  });
});

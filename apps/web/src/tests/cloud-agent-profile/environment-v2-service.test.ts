/**
 * Integration test for multi-repository (V2) environments in the service of
 * `@kilocode/cloud-agent-profile`, against the web Postgres test harness. V1
 * behavior is covered by `environment-service.test.ts`.
 */
import { generateKeyPairSync } from 'node:crypto';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { cloud_agent_environments, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { isUniqueViolation } from '@/lib/db-errors';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  createEnvironment,
  getEnvironment,
  listEnvironments,
  listEnvironmentsForOwner,
  loadEnvironmentBuildInput,
  loadEnvironmentForSession,
  readEnvironmentReference,
  updateEnvironment,
  type EnvironmentCreateInput,
  type EnvironmentOwner,
  type EnvironmentRepositoryEntry,
  type EnvironmentRepositoryIdentity,
  type EnvironmentUpdateInput,
} from '@kilocode/cloud-agent-profile';

const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyBase64 = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString(
  'base64'
);

const WORKSPACE_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REPOSITORY_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const github = (repoFullName: string): EnvironmentRepositoryEntry => ({
  platform: 'github',
  repoFullName,
});
const gitlab = (repoFullName: string, gitlabCloneUrl: string): EnvironmentRepositoryEntry => ({
  platform: 'gitlab',
  repoFullName,
  gitlabCloneUrl,
});
const bitbucket = (repoFullName: string): EnvironmentRepositoryEntry => ({
  platform: 'bitbucket',
  repoFullName,
  bitbucketWorkspaceUuid: WORKSPACE_UUID,
  bitbucketRepositoryUuid: REPOSITORY_UUID,
});

function userOwner(id: string): EnvironmentOwner {
  return { type: 'user', id };
}

async function createV2(
  owner: EnvironmentOwner,
  repositories: EnvironmentRepositoryEntry[],
  name = 'multi'
): Promise<string> {
  return createEnv({ owner, createdByUserId: 'creator', name, repositories });
}

async function createV1(owner: EnvironmentOwner, repoFullName: string, name = 'single') {
  return createEnv({
    owner,
    createdByUserId: 'creator',
    name,
    platform: 'github',
    repoFullName,
  });
}

async function createEnv(input: EnvironmentCreateInput): Promise<string> {
  return db.transaction(async tx => (await createEnvironment(tx, publicKeyBase64, input)).id);
}

async function updateEnv(input: EnvironmentUpdateInput): Promise<number> {
  return db.transaction(
    async tx => (await updateEnvironment(tx, publicKeyBase64, input)).configurationRevision
  );
}

async function storedRow(id: string) {
  const [row] = await db
    .select()
    .from(cloud_agent_environments)
    .where(eq(cloud_agent_environments.id, id));
  return row;
}

describe('multi-repository (V2) environments', () => {
  afterEach(cleanupDbForTest);

  describe('create', () => {
    test('stores normalized repositories and no identity columns', async () => {
      const user = await insertTestUser();
      const id = await createV2(userOwner(user.id), [
        github(' Acme/Widgets '),
        gitlab('Group/Tool', ' https://gitlab.com/group/tool.git '),
        bitbucket('Team/Lib'),
      ]);

      const row = await storedRow(id);
      expect(row.platform).toBeNull();
      expect(row.repo_full_name).toBeNull();
      expect(row.repositories).toEqual([
        { platform: 'github', repoFullName: 'acme/widgets' },
        {
          platform: 'gitlab',
          repoFullName: 'group/tool',
          gitlabCloneUrl: 'https://gitlab.com/group/tool.git',
        },
        {
          platform: 'bitbucket',
          repoFullName: 'team/lib',
          bitbucketWorkspaceUuid: WORKSPACE_UUID,
          bitbucketRepositoryUuid: REPOSITORY_UUID,
        },
      ]);
    });

    test('rejects an input with both a V1 identity and repositories, or with neither', async () => {
      const user = await insertTestUser();
      const base = { owner: userOwner(user.id), createdByUserId: user.id, name: 'bad' };

      await expect(
        createEnv({
          ...base,
          platform: 'github',
          repoFullName: 'acme/a',
          repositories: [github('acme/b')],
        } as unknown as EnvironmentCreateInput)
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      await expect(createEnv(base as unknown as EnvironmentCreateInput)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      expect(await listEnvironmentsForOwner(db, userOwner(user.id))).toEqual([]);
    });

    test.each([
      { name: 'an empty list', repositories: [], message: /at least one repository/ },
      {
        name: 'a repository listed twice',
        repositories: [github('acme/widgets'), github('Acme/Widgets')],
        message: /Repository acme\/widgets is listed more than once/,
      },
      {
        name: 'an unsafe directory name',
        repositories: [github('acme/ok'), github('acme/bad name')],
        message: /acme\/bad name.*unsafe/,
      },
      {
        name: 'two repositories with the same directory name',
        repositories: [
          github('acme/Tool'),
          gitlab('group/tool', 'https://gitlab.com/group/tool.git'),
        ],
        message: /acme\/tool and group\/tool use the same directory name/,
      },
    ])(
      'rejects $name with a message that names the repositories',
      async ({ repositories, message }) => {
        const user = await insertTestUser();

        await expect(createV2(userOwner(user.id), repositories)).rejects.toMatchObject({
          code: 'BAD_REQUEST',
          message: expect.stringMatching(message),
        });
        expect(await listEnvironmentsForOwner(db, userOwner(user.id))).toEqual([]);
      }
    );

    test('allows a repository that also has a V1 environment, and keeps V1 unique', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      await createV1(owner, 'acme/widgets');

      await expect(createV2(owner, [github('acme/widgets'), github('acme/api')])).resolves.toEqual(
        expect.any(String)
      );
      const duplicate = await createV1(owner, 'ACME/widgets', 'duplicate').catch(error => error);
      expect(isUniqueViolation(duplicate)).toBe(true);
    });

    test('returns repositories and no identity scalars', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const id = await createV2(owner, [github('acme/widgets'), github('acme/api')]);

      const response = await getEnvironment(db, id, owner);
      expect(response.repositories).toEqual([github('acme/widgets'), github('acme/api')]);
      expect(response).not.toHaveProperty('platform');
      expect(response).not.toHaveProperty('repoFullName');

      const [summary] = await listEnvironmentsForOwner(db, owner);
      expect(summary.repositories).toEqual([github('acme/widgets'), github('acme/api')]);
      expect(summary).not.toHaveProperty('platform');
    });
  });

  describe('update', () => {
    test('replaces repositories and advances the revision only when they change', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const id = await createV2(owner, [github('acme/widgets'), github('acme/api')]);

      const renamed = await updateEnv({ owner, environmentId: id, name: 'renamed' });
      const unchanged = await updateEnv({
        owner,
        environmentId: id,
        repositories: [github('Acme/Widgets'), github('acme/api')],
      });
      expect(renamed).toBe(1);
      expect(unchanged).toBe(1);

      const changed = await updateEnv({
        owner,
        environmentId: id,
        repositories: [github('acme/widgets'), github('acme/web')],
      });
      expect(changed).toBe(2);
      expect((await getEnvironment(db, id, owner)).repositories).toEqual([
        github('acme/widgets'),
        github('acme/web'),
      ]);
    });

    test('an update that restates GitLab and Bitbucket entries keeps the revision', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const id = await createV2(owner, [
        gitlab('group/tool', 'https://gitlab.com/group/tool.git'),
        bitbucket('team/lib'),
      ]);

      const restated = await updateEnv({
        owner,
        environmentId: id,
        repositories: [
          gitlab('Group/Tool', ' https://gitlab.com/group/tool.git '),
          {
            platform: 'bitbucket',
            repoFullName: 'Team/Lib',
            bitbucketWorkspaceUuid: WORKSPACE_UUID.toUpperCase(),
            bitbucketRepositoryUuid: REPOSITORY_UUID.toUpperCase(),
          },
        ],
      });
      expect(restated).toBe(1);
      expect((await storedRow(id)).configuration_revision).toBe(1);

      const changed = await updateEnv({
        owner,
        environmentId: id,
        repositories: [
          gitlab('group/tool', 'https://gitlab.com/group/other.git'),
          bitbucket('team/lib'),
        ],
      });
      expect(changed).toBe(2);
    });

    test('rejects an invalid list with a message that names the repositories and writes nothing', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const id = await createV2(owner, [github('acme/widgets')]);

      await expect(
        updateEnv({
          owner,
          environmentId: id,
          name: 'should not be written',
          repositories: [github('acme/a/tool'), github('acme/b/Tool')],
        })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringMatching(/acme\/a\/tool and acme\/b\/tool use the same directory/),
      });
      const row = await storedRow(id);
      expect(row.name).toBe('multi');
      expect(row.configuration_revision).toBe(1);
    });

    test('rejects repositories on a V1 environment', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const id = await createV1(owner, 'acme/widgets');

      await expect(
        updateEnv({ owner, environmentId: id, repositories: [github('acme/widgets')] })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
      const row = await storedRow(id);
      expect(row.repositories).toBeNull();
      expect(row.repo_full_name).toBe('acme/widgets');
    });
  });

  describe('loadEnvironmentForSession', () => {
    const owner = (id: string) => userOwner(id);

    function match(resolution: Awaited<ReturnType<typeof loadEnvironmentForSession>>) {
      if (resolution.status !== 'match')
        throw new Error(`expected a match, got ${resolution.status}`);
      return resolution.environment;
    }

    test('finds a V2 environment by containment on each platform, in any member position', async () => {
      const user = await insertTestUser();
      const id = await createV2(owner(user.id), [
        github('acme/widgets'),
        gitlab('group/tool', 'https://gitlab.com/group/tool.git'),
        bitbucket('team/lib'),
      ]);

      const probes: EnvironmentRepositoryIdentity[] = [
        { platform: 'github', repoFullName: 'ACME/Widgets' },
        { platform: 'gitlab', cloneUrl: ' https://gitlab.com/group/tool.git ' },
        {
          platform: 'bitbucket',
          workspaceUuid: WORKSPACE_UUID.toUpperCase(),
          repositoryUuid: REPOSITORY_UUID.toUpperCase(),
        },
      ];
      for (const repository of probes) {
        const environment = match(
          await loadEnvironmentForSession(db, { owner: owner(user.id), repository })
        );
        expect(environment.reference.environmentId).toBe(id);
        expect(environment.reference.repositories?.map(entry => entry.leaf)).toEqual([
          'widgets',
          'tool',
          'lib',
        ]);
        expect(environment.reference.repository).toBeUndefined();
        expect(environment.layer.repositories).toEqual(environment.reference.repositories);
      }
    });

    test('matches a renamed Bitbucket repository by its UUID pair', async () => {
      const user = await insertTestUser();
      await createV2(owner(user.id), [bitbucket('team/old-name')]);

      const resolution = await loadEnvironmentForSession(db, {
        owner: owner(user.id),
        repository: {
          platform: 'bitbucket',
          workspaceUuid: WORKSPACE_UUID,
          repositoryUuid: REPOSITORY_UUID,
        },
      });
      expect(resolution.status).toBe('match');
    });

    test('a V1 match keeps the V1 shape', async () => {
      const user = await insertTestUser();
      await createV1(owner(user.id), 'acme/widgets');

      const environment = match(
        await loadEnvironmentForSession(db, {
          owner: owner(user.id),
          repository: { platform: 'github', repoFullName: 'Acme/Widgets' },
        })
      );
      expect(environment.reference.repository).toEqual({
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      expect(environment.reference.repositories).toBeUndefined();
      expect(environment.layer.repositories).toBeUndefined();
    });

    test('reports a conflict, with every environment named, when a V1 and a V2 environment contain the repository', async () => {
      const user = await insertTestUser();
      const v1 = await createV1(owner(user.id), 'acme/widgets', 'B single');
      const v2 = await createV2(
        owner(user.id),
        [github('acme/api'), github('acme/widgets')],
        'A multi'
      );

      await expect(
        loadEnvironmentForSession(db, {
          owner: owner(user.id),
          repository: { platform: 'github', repoFullName: 'acme/widgets' },
        })
      ).resolves.toEqual({
        status: 'conflict',
        environments: [
          { id: v2, name: 'A multi' },
          { id: v1, name: 'B single' },
        ],
      });
    });

    test('reports a conflict between two V2 environments', async () => {
      const user = await insertTestUser();
      await createV2(owner(user.id), [github('acme/widgets'), github('acme/api')], 'one');
      await createV2(owner(user.id), [github('acme/widgets'), github('acme/web')], 'two');

      const resolution = await loadEnvironmentForSession(db, {
        owner: owner(user.id),
        repository: { platform: 'github', repoFullName: 'acme/widgets' },
      });
      expect(resolution).toMatchObject({ status: 'conflict' });
    });

    test('reports none for a repository no environment contains, another owner, and a deleted organization', async () => {
      const user = await insertTestUser();
      const other = await insertTestUser();
      await createV2(owner(user.id), [github('acme/widgets'), github('acme/api')]);
      const organization = await createTestOrganization('V2 org', user.id, 0);
      const orgOwner: EnvironmentOwner = { type: 'organization', id: organization.id };
      await createV2(orgOwner, [github('acme/widgets')], 'org');

      const widgets: EnvironmentRepositoryIdentity = {
        platform: 'github',
        repoFullName: 'acme/widgets',
      };
      await expect(
        loadEnvironmentForSession(db, {
          owner: owner(user.id),
          repository: { platform: 'github', repoFullName: 'acme/other' },
        })
      ).resolves.toEqual({ status: 'none' });
      await expect(
        loadEnvironmentForSession(db, { owner: owner(other.id), repository: widgets })
      ).resolves.toEqual({ status: 'none' });

      await db
        .update(organizations)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(organizations.id, organization.id));
      await expect(
        loadEnvironmentForSession(db, { owner: orgOwner, repository: widgets })
      ).resolves.toEqual({ status: 'none' });
    });

    describe('with a requested environment id', () => {
      const widgets: EnvironmentRepositoryIdentity = {
        platform: 'github',
        repoFullName: 'acme/widgets',
      };

      test('selects it without a conflict when several contain the repository', async () => {
        const user = await insertTestUser();
        await createV1(owner(user.id), 'acme/widgets', 'single');
        const v2 = await createV2(owner(user.id), [github('acme/widgets'), github('acme/api')]);

        const environment = match(
          await loadEnvironmentForSession(db, {
            owner: owner(user.id),
            repository: widgets,
            environmentId: v2,
          })
        );
        expect(environment.reference.environmentId).toBe(v2);
      });

      test('reports that an environment of another owner is not found', async () => {
        const user = await insertTestUser();
        const other = await insertTestUser();
        const theirs = await createV2(owner(other.id), [github('acme/widgets')]);

        await expect(
          loadEnvironmentForSession(db, {
            owner: owner(user.id),
            repository: widgets,
            environmentId: theirs,
          })
        ).resolves.toEqual({ status: 'requested-not-found' });
      });

      test('reports that an environment without the launch repository does not contain it', async () => {
        const user = await insertTestUser();
        const mine = await createV2(owner(user.id), [github('acme/api'), github('acme/web')]);

        await expect(
          loadEnvironmentForSession(db, {
            owner: owner(user.id),
            repository: widgets,
            environmentId: mine,
          })
        ).resolves.toEqual({ status: 'requested-without-repository' });
      });
    });
  });

  describe('listEnvironments', () => {
    test('lists V1 and V2 environments that contain the repository, ordered by name', async () => {
      const user = await insertTestUser();
      const o = userOwner(user.id);
      const v1 = await createV1(o, 'acme/widgets', 'B single');
      const v2 = await createV2(o, [github('acme/api'), github('acme/widgets')], 'A multi');
      await createV2(o, [github('acme/api')], 'unrelated');

      const listed = await listEnvironments(db, o, {
        platform: 'github',
        repoFullName: 'Acme/Widgets',
      });
      expect(listed.map(environment => environment.id)).toEqual([v2, v1]);
    });
  });

  describe('references and build inputs', () => {
    test('a V2 reference and build input list every repository and no launch repository', async () => {
      const user = await insertTestUser();
      const o = userOwner(user.id);
      const id = await createV2(o, [github('acme/widgets'), bitbucket('Team/Lib')]);

      const reference = await readEnvironmentReference(db, id);
      expect(reference).toEqual({
        environmentId: id,
        owner: o,
        configurationRevision: 1,
        repositories: [
          {
            identity: { platform: 'github', repoFullName: 'acme/widgets' },
            repoFullName: 'acme/widgets',
            leaf: 'widgets',
          },
          {
            identity: {
              platform: 'bitbucket',
              workspaceUuid: WORKSPACE_UUID,
              repositoryUuid: REPOSITORY_UUID,
            },
            repoFullName: 'team/lib',
            leaf: 'lib',
          },
        ],
      });

      const input = await loadEnvironmentBuildInput(db, id);
      expect(input?.reference).toEqual(reference);
      expect(input?.repositories).toEqual(reference?.repositories);
      expect(input).not.toHaveProperty('repoFullName');
    });

    test('a stored list that fails the entry schema is an internal error, not a silent read', async () => {
      const user = await insertTestUser();
      const id = await createV2(userOwner(user.id), [github('acme/widgets')]);
      await db
        .update(cloud_agent_environments)
        .set({ repositories: [{ platform: 'github' }] })
        .where(eq(cloud_agent_environments.id, id));

      await expect(getEnvironment(db, id, userOwner(user.id))).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
      await expect(readEnvironmentReference(db, id)).rejects.toMatchObject({
        code: 'INTERNAL_SERVER_ERROR',
      });
    });
  });
});

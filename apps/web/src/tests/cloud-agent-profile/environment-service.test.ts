/**
 * Integration test for the repository environment service in
 * `@kilocode/cloud-agent-profile`, exercised against the web Postgres test
 * harness because that's where the Drizzle migrations, seed helpers, and Jest
 * setup already live.
 */
import { generateKeyPairSync } from 'node:crypto';
import { decryptWithPrivateKey } from '@kilocode/encryption';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  cloud_agent_environment_vars,
  cloud_agent_environments,
  organizations,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { isUniqueViolation } from '@/lib/db-errors';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { markOrganizationAsDeleted } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  createEnvironment,
  deleteEnvironment,
  getEnvironment,
  listEnvironments,
  listEnvironmentsForOwner,
  loadEnvironmentBuildInput,
  loadEnvironmentForSession,
  lockActiveOrganization,
  readEnvironmentReference,
  updateEnvironment,
  ENVIRONMENT_LIMITS,
  MASKED_SECRET_VALUE,
  type EnvironmentCreateInput,
  type EnvironmentOwner,
  type EnvironmentRepositoryIdentity,
  type EnvironmentUpdateInput,
} from '@kilocode/cloud-agent-profile';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyBase64 = Buffer.from(publicKey.export({ type: 'spki', format: 'pem' })).toString(
  'base64'
);
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const SECRET_PLAINTEXT = 'swordfish-secret-value';

/** Wrap a transaction so a test can see which statements the service built. */
function recordStatements<T extends object>(tx: T, statements: string[]): T {
  return new Proxy(tx, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value === 'function') {
        if (typeof property === 'string') statements.push(property);
        return value.bind(target);
      }
      return value;
    },
  });
}

async function createEnv(input: EnvironmentCreateInput): Promise<string> {
  return db.transaction(async tx => {
    const { id } = await createEnvironment(tx, publicKeyBase64, input);
    return id;
  });
}

async function updateEnv(input: EnvironmentUpdateInput): Promise<number> {
  return db.transaction(async tx => {
    const { configurationRevision } = await updateEnvironment(tx, publicKeyBase64, input);
    return configurationRevision;
  });
}

function userOwner(id: string): EnvironmentOwner {
  return { type: 'user', id };
}

async function storedSecretValue(environmentId: string, key: string): Promise<string> {
  const [row] = await db
    .select({ value: cloud_agent_environment_vars.value })
    .from(cloud_agent_environment_vars)
    .where(
      and(
        eq(cloud_agent_environment_vars.environment_id, environmentId),
        eq(cloud_agent_environment_vars.key, key)
      )
    );
  return row.value;
}

describe('repository environment service', () => {
  afterEach(cleanupDbForTest);

  describe('create and get', () => {
    test('stores commands, plaintext vars, and encrypted secrets, and never returns secret values', async () => {
      const user = await insertTestUser();
      const id = await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'Acme/Widgets',
        plainVars: { PLAIN: 'plain-value' },
        secrets: { API_KEY: SECRET_PLAINTEXT },
        commands: ['npm ci\nnpm test'],
      });

      const stored = await storedSecretValue(id, 'API_KEY');
      expect(stored).not.toContain(SECRET_PLAINTEXT);
      expect(JSON.parse(stored)).toMatchObject({ algorithm: 'rsa-aes-256-gcm', version: 1 });

      const environment = await getEnvironment(db, id, userOwner(user.id));

      expect(environment.repoFullName).toBe('acme/widgets');
      expect(environment.platform).toBe('github');
      expect(environment.plainVars).toEqual([
        expect.objectContaining({ key: 'PLAIN', value: 'plain-value' }),
      ]);
      expect(environment.commands).toEqual(['npm ci\nnpm test']);
      expect(environment.secretKeys).toEqual(['API_KEY']);
      expect(JSON.stringify(environment)).not.toContain(SECRET_PLAINTEXT);
    });

    test('rejects a key that is both a plaintext var and a secret', async () => {
      const user = await insertTestUser();

      await expect(
        createEnv({
          owner: userOwner(user.id),
          createdByUserId: user.id,
          name: 'collision',
          platform: 'github',
          repoFullName: 'acme/widgets',
          plainVars: { SHARED: 'plain-value' },
          secrets: { SHARED: 'secret-value' },
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    test('lowercases the GitHub identity and rejects a foreign owner', async () => {
      const user = await insertTestUser();
      const other = await insertTestUser();
      const id = await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'default',
        platform: 'github',
        repoFullName: 'Acme/Widgets',
      });

      const [row] = await db
        .select({ repoFullName: cloud_agent_environments.repo_full_name })
        .from(cloud_agent_environments)
        .where(eq(cloud_agent_environments.id, id));
      expect(row.repoFullName).toBe('acme/widgets');

      await expect(getEnvironment(db, id, userOwner(other.id))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });

    test('requires an active organization for an organization-owned environment', async () => {
      const owner = await insertTestUser();
      const organization = await createTestOrganization('Env org', owner.id, 0);

      await expect(
        createEnv({
          owner: { type: 'organization', id: organization.id },
          createdByUserId: owner.id,
          name: 'org-env',
          platform: 'bitbucket',
          repoFullName: 'team/repo',
          bitbucketWorkspaceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          bitbucketRepositoryUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        })
      ).resolves.toEqual(expect.any(String));

      await markOrganizationAsDeleted(organization.id);
      await expect(
        createEnv({
          owner: { type: 'organization', id: organization.id },
          createdByUserId: owner.id,
          name: 'after-delete',
          platform: 'github',
          repoFullName: 'team/repo',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(
        createEnv({
          owner: { type: 'organization', id: '550e8400-e29b-41d4-a716-446655440099' },
          createdByUserId: owner.id,
          name: 'missing-org',
          platform: 'github',
          repoFullName: 'team/repo',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('lockActiveOrganization rejects a deleted organization and accepts an active one', async () => {
      const owner = await insertTestUser();
      const organization = await createTestOrganization('Lock org', owner.id, 0);

      await db.transaction(async tx => {
        await lockActiveOrganization(tx, organization.id);
      });

      await db
        .update(organizations)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(organizations.id, organization.id));

      await expect(
        db.transaction(async tx => {
          await lockActiveOrganization(tx, organization.id);
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('the organization lock serialises a create with markOrganizationAsDeleted', async () => {
      const owner = await insertTestUser();
      const organization = await createTestOrganization('Lock race org', owner.id, 0);

      let releaseCreate!: () => void;
      const holdCreate = new Promise<void>(resolve => {
        releaseCreate = resolve;
      });
      let createLocked!: () => void;
      const createHoldsLock = new Promise<void>(resolve => {
        createLocked = resolve;
      });

      const createTransaction = db.transaction(async tx => {
        await lockActiveOrganization(tx, organization.id);
        await tx.insert(cloud_agent_environments).values({
          owned_by_organization_id: organization.id,
          name: 'raced',
          platform: 'github',
          repo_full_name: 'acme/widgets',
        });
        createLocked();
        await holdCreate;
      });

      await createHoldsLock;

      const softDelete = markOrganizationAsDeleted(organization.id);
      const outcome = await Promise.race([
        softDelete.then(() => 'done' as const),
        new Promise<'blocked'>(resolve => setTimeout(() => resolve('blocked'), 500)),
      ]);
      // Without the `for update`, the soft delete would take the row and finish
      // while the create transaction still holds it.
      expect(outcome).toBe('blocked');

      releaseCreate();
      await createTransaction;
      await softDelete;

      const [organizationRow] = await db
        .select({ deletedAt: organizations.deleted_at })
        .from(organizations)
        .where(eq(organizations.id, organization.id));
      expect(organizationRow.deletedAt).not.toBeNull();

      const environments = await db
        .select({ id: cloud_agent_environments.id })
        .from(cloud_agent_environments)
        .where(eq(cloud_agent_environments.owned_by_organization_id, organization.id));
      expect(environments).toEqual([]);
    });
  });

  describe('update', () => {
    test('replaces the plaintext set and commands while retaining unnamed secrets', async () => {
      const user = await insertTestUser();
      const id = await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
        plainVars: { REMOVE_ME: 'x', KEEP: 'y' },
        secrets: { RETAINED: 'retained-value' },
        commands: ['old-command'],
      });

      await updateEnv({
        owner: userOwner(user.id),
        environmentId: id,
        name: 'CI renamed',
        plainVars: { ONLY: 'z' },
        secrets: [{ key: 'ADDED', value: 'added-value' }],
        commands: ['new-command'],
      });

      const environment = await getEnvironment(db, id, userOwner(user.id));
      expect(environment.name).toBe('CI renamed');
      expect(environment.plainVars).toEqual([expect.objectContaining({ key: 'ONLY', value: 'z' })]);
      expect(environment.secretKeys).toEqual(['ADDED', 'RETAINED']);
      expect(environment.commands).toEqual(['new-command']);
    });

    test('deletes only the secrets named with delete:true', async () => {
      const user = await insertTestUser();
      const id = await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
        secrets: { KEEP: 'keep-value', DROP: 'drop-value' },
      });

      await updateEnv({
        owner: userOwner(user.id),
        environmentId: id,
        secrets: [
          { key: 'DROP', delete: true },
          { key: 'KEEP', value: 'changed-value' },
        ],
      });

      const environment = await getEnvironment(db, id, userOwner(user.id));
      expect(environment.secretKeys).toEqual(['KEEP']);
      expect(await storedSecretValue(id, 'KEEP')).not.toContain('keep-value');
    });

    test('rejects plaintext vars that collide with a secret change', async () => {
      const user = await insertTestUser();
      const id = await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      await expect(
        updateEnv({
          owner: userOwner(user.id),
          environmentId: id,
          plainVars: { SHARED: 'plain-value' },
          secrets: [{ key: 'SHARED', value: 'secret-value' }],
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    test('rejects plaintext vars that collide with a retained existing secret', async () => {
      const user = await insertTestUser();
      const id = await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
        secrets: { RETAINED: 'retained-value' },
      });

      await expect(
        updateEnv({
          owner: userOwner(user.id),
          environmentId: id,
          plainVars: { RETAINED: 'plain-value' },
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      const environment = await getEnvironment(db, id, userOwner(user.id));
      expect(environment.secretKeys).toEqual(['RETAINED']);
      expect(environment.plainVars).toEqual([]);
    });

    test('a secret delete does not remove a plaintext var of the same name', async () => {
      const user = await insertTestUser();
      const id = await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
        plainVars: { KEPT: 'plain-value' },
      });

      await updateEnv({
        owner: userOwner(user.id),
        environmentId: id,
        secrets: [{ key: 'KEPT', delete: true }],
      });

      const environment = await getEnvironment(db, id, userOwner(user.id));
      expect(environment.plainVars).toEqual([
        expect.objectContaining({ key: 'KEPT', value: 'plain-value' }),
      ]);
    });

    test('replaces a deleted secret with a plaintext var of the same name', async () => {
      const user = await insertTestUser();
      const id = await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
        secrets: { CONVERT: 'secret-value' },
      });

      await updateEnv({
        owner: userOwner(user.id),
        environmentId: id,
        plainVars: { CONVERT: 'plain-value' },
        secrets: [{ key: 'CONVERT', delete: true }],
      });

      const environment = await getEnvironment(db, id, userOwner(user.id));
      expect(environment.plainVars).toEqual([
        expect.objectContaining({ key: 'CONVERT', value: 'plain-value' }),
      ]);
      expect(environment.secretKeys).toEqual([]);
    });

    test('rejects a masked placeholder and a reserved key', async () => {
      const user = await insertTestUser();
      const id = await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      await expect(
        updateEnv({
          owner: userOwner(user.id),
          environmentId: id,
          secrets: [{ key: 'API_KEY', value: MASKED_SECRET_VALUE }],
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await expect(
        updateEnv({
          owner: userOwner(user.id),
          environmentId: id,
          plainVars: { HOME: '/tmp' },
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    test('rejects a foreign owner', async () => {
      const user = await insertTestUser();
      const other = await insertTestUser();
      const id = await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      await expect(
        updateEnv({
          owner: userOwner(other.id),
          environmentId: id,
          name: 'hijack',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('list', () => {
    test('filters by GitHub repository path and reports counts', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'main',
        platform: 'github',
        repoFullName: 'Acme/Widgets',
        plainVars: { PLAIN: 'plain-listing-value' },
        secrets: { S1: 'secret-one-value', S2: 'secret-two-value' },
        commands: ['one\ntwo'],
      });
      await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'other',
        platform: 'github',
        repoFullName: 'Acme/Other',
      });

      const summaries = await listEnvironments(db, owner, {
        platform: 'github',
        repoFullName: 'ACME/Widgets',
      });

      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({
        name: 'main',
        plainVarCount: 1,
        secretCount: 2,
        commandCount: 1,
      });
      expect(JSON.stringify(summaries)).not.toContain('secret-one-value');
      expect(JSON.stringify(summaries)).not.toContain('secret-two-value');
    });

    test('matches GitLab by the canonical clone URL string', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'gitlab',
        platform: 'gitlab',
        repoFullName: 'group/project',
        gitlabCloneUrl: 'https://gitlab.com/group/project.git',
      });

      const matching = await listEnvironments(db, owner, {
        platform: 'gitlab',
        cloneUrl: 'https://gitlab.com/group/project.git',
      });
      const other = await listEnvironments(db, owner, {
        platform: 'gitlab',
        cloneUrl: 'https://gitlab.com/group/project',
      });

      expect(matching).toHaveLength(1);
      expect(other).toHaveLength(0);
    });

    test('matches Bitbucket by UUID pair across a repository rename', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const workspaceUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const repositoryUuid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'bitbucket',
        platform: 'bitbucket',
        repoFullName: 'team/old-name',
        bitbucketWorkspaceUuid: workspaceUuid,
        bitbucketRepositoryUuid: repositoryUuid,
      });

      const summaries = await listEnvironments(db, owner, {
        platform: 'bitbucket',
        workspaceUuid,
        repositoryUuid,
      });

      expect(summaries).toHaveLength(1);
      expect(summaries[0].repoFullName).toBe('team/old-name');
    });

    test('scopes personal and organization lists', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Env scope org', user.id, 0);

      await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'personal',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      await createEnv({
        owner: { type: 'organization', id: organization.id },
        createdByUserId: user.id,
        name: 'shared',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      const personal = await listEnvironments(db, userOwner(user.id), {
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      const shared = await listEnvironments(
        db,
        { type: 'organization', id: organization.id },
        {
          platform: 'github',
          repoFullName: 'acme/widgets',
        }
      );

      expect(personal.map(summary => summary.name)).toEqual(['personal']);
      expect(shared.map(summary => summary.name)).toEqual(['shared']);
    });

    test('lists every repository for an owner', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);

      await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'a',
        platform: 'github',
        repoFullName: 'acme/one',
      });
      await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'b',
        platform: 'gitlab',
        repoFullName: 'acme/two',
        gitlabCloneUrl: 'https://gitlab.com/acme/two.git',
      });

      const all = await listEnvironmentsForOwner(db, owner);

      expect(all.map(summary => summary.name)).toEqual(['a', 'b']);
      expect(all.map(summary => summary.repoFullName)).toEqual(['acme/one', 'acme/two']);
    });
  });

  describe('delete', () => {
    test('deletes the environment and its variables and commands', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const id = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
        plainVars: { PLAIN: 'p' },
        secrets: { SECRET: 's' },
        commands: ['cmd'],
      });

      await deleteEnvironment(db, id, owner);

      await expect(getEnvironment(db, id, owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      const vars = await db
        .select({ id: cloud_agent_environment_vars.id })
        .from(cloud_agent_environment_vars)
        .where(eq(cloud_agent_environment_vars.environment_id, id));
      expect(vars).toHaveLength(0);

      await expect(deleteEnvironment(db, id, owner)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    test('rejects a foreign owner', async () => {
      const user = await insertTestUser();
      const other = await insertTestUser();
      const id = await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      await expect(deleteEnvironment(db, id, userOwner(other.id))).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('one environment per repository', () => {
    test('rejects a second environment for the same repository and owner', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'first',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      const duplicate = createEnv({
        owner,
        createdByUserId: user.id,
        name: 'second',
        platform: 'github',
        repoFullName: 'Acme/Widgets',
      });
      await expect(duplicate).rejects.toThrow();
      expect(isUniqueViolation(await duplicate.catch((error: unknown) => error))).toBe(true);
    });

    test('allows the same repository for another owner, and a rename', async () => {
      const user = await insertTestUser();
      const organization = await createTestOrganization('Unique org', user.id, 0);
      const id = await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'personal',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      await createEnv({
        owner: { type: 'organization', id: organization.id },
        createdByUserId: user.id,
        name: 'shared',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      await updateEnv({ owner: userOwner(user.id), environmentId: id, name: 'Renamed' });

      expect((await getEnvironment(db, id, userOwner(user.id))).name).toBe('Renamed');
    });
  });

  describe('sandbox allocation', () => {
    test('saves, keeps, and clears the size without advancing the revision', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const id = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
        sandboxAllocation: 'cloudflare-single',
      });
      expect(await getEnvironment(db, id, owner)).toMatchObject({
        sandboxAllocation: 'cloudflare-single',
        configurationRevision: 1,
      });

      await expect(
        updateEnv({ owner, environmentId: id, sandboxAllocation: 'vercel-large' })
      ).resolves.toBe(1);
      await expect(updateEnv({ owner, environmentId: id, name: 'Renamed' })).resolves.toBe(1);
      expect((await getEnvironment(db, id, owner)).sandboxAllocation).toBe('vercel-large');

      await expect(updateEnv({ owner, environmentId: id, sandboxAllocation: null })).resolves.toBe(
        1
      );
      const [summary] = await listEnvironmentsForOwner(db, owner);
      expect(summary).toMatchObject({ sandboxAllocation: null, configurationRevision: 1 });
    });
  });

  describe('loadEnvironmentForSession', () => {
    test('does not mix variable values with a concurrent configuration revision', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const id = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'Consistent',
        platform: 'github',
        repoFullName: 'acme/consistent',
        plainVars: { VALUE: 'before' },
      });
      let edited = false;
      // Commit an edit after the first real read; keep the SQL and transaction real.
      const wrapQuery = (query: object): object =>
        new Proxy(query, {
          get(target, key) {
            const value: unknown = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            if (key === 'then')
              return (
                resolve: (value: unknown) => unknown,
                reject: (error: unknown) => unknown
              ) => {
                const read = Reflect.apply(value, target, [
                  (rows: unknown) => rows,
                ]) as Promise<unknown>;
                return read
                  .then(async rows => {
                    if (!edited) {
                      edited = true;
                      await updateEnv({ owner, environmentId: id, plainVars: { VALUE: 'after' } });
                    }
                    return rows;
                  })
                  .then(resolve, reject);
              };
            return (...args: unknown[]) => {
              const next: unknown = Reflect.apply(value, target, args);
              return next !== null && typeof next === 'object' ? wrapQuery(next) : next;
            };
          },
        });
      const instrument = <T extends object>(database: T): T =>
        new Proxy(database, {
          get(target, key) {
            const value: unknown = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            if (key === 'select')
              return (...args: unknown[]) =>
                wrapQuery(Reflect.apply(value, target, args) as object);
            if (key === 'transaction')
              return (body: (tx: object) => unknown, ...options: unknown[]) =>
                Reflect.apply(value, target, [(tx: object) => body(instrument(tx)), ...options]);
            return value.bind(target);
          },
        });
      const loaded = await loadEnvironmentForSession(instrument(db), {
        owner,
        repository: { platform: 'github', repoFullName: 'acme/consistent' },
      });
      expect(edited).toBe(true);
      expect(loaded?.reference.configurationRevision).toBe(1);
      expect(loaded?.layer.envVars).toEqual({ VALUE: 'before' });
      const current = await loadEnvironmentForSession(db, {
        owner,
        repository: { platform: 'github', repoFullName: 'acme/consistent' },
      });
      expect(current?.reference.configurationRevision).toBe(2);
      expect(current?.layer.envVars).toEqual({ VALUE: 'after' });
    });

    test('returns vars, envelopes, ordered commands, and size for the repository', async () => {
      const user = await insertTestUser();
      await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'CI',
        platform: 'github',
        repoFullName: 'Acme/Widgets',
        plainVars: { PLAIN: 'plain-value' },
        secrets: { API_KEY: SECRET_PLAINTEXT },
        commands: ['first\nsecond'],
        sandboxAllocation: 'cloudflare-shared',
      });

      const environment = await loadEnvironmentForSession(db, {
        owner: userOwner(user.id),
        repository: { platform: 'github', repoFullName: 'ACME/widgets' },
      });

      expect(environment?.sandboxAllocation).toBe('cloudflare-shared');
      const layer = environment?.layer;
      expect(layer?.envVars).toEqual({ PLAIN: 'plain-value' });
      expect(Object.keys(layer?.encryptedSecrets ?? {})).toEqual(['API_KEY']);
      expect(JSON.stringify(layer?.encryptedSecrets)).not.toContain(SECRET_PLAINTEXT);
      expect(layer?.setupCommands).toEqual(['first\nsecond']);
    });

    test('returns null for another repository, a foreign owner, and a deleted organization', async () => {
      const user = await insertTestUser();
      const other = await insertTestUser();
      const repository: EnvironmentRepositoryIdentity = {
        platform: 'github',
        repoFullName: 'acme/widgets',
      };
      await createEnv({
        owner: userOwner(user.id),
        createdByUserId: user.id,
        name: 'personal',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });

      await expect(
        loadEnvironmentForSession(db, {
          owner: userOwner(user.id),
          repository: { platform: 'github', repoFullName: 'acme/other' },
        })
      ).resolves.toBeNull();
      await expect(
        loadEnvironmentForSession(db, { owner: userOwner(other.id), repository })
      ).resolves.toBeNull();

      const organization = await createTestOrganization('Loader org', user.id, 0);
      const orgOwner: EnvironmentOwner = { type: 'organization', id: organization.id };
      await createEnv({
        owner: orgOwner,
        createdByUserId: user.id,
        name: 'org',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      await expect(
        loadEnvironmentForSession(db, { owner: orgOwner, repository })
      ).resolves.not.toBeNull();
      await db
        .update(organizations)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(organizations.id, organization.id));

      await expect(
        loadEnvironmentForSession(db, { owner: orgOwner, repository })
      ).resolves.toBeNull();
    });

    test('matches GitLab by the canonical clone URL and Bitbucket by UUID pair', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const gitlabId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'gitlab',
        platform: 'gitlab',
        repoFullName: 'group/project',
        gitlabCloneUrl: 'https://gitlab.com/group/project.git',
        commands: ['gitlab-setup'],
      });
      const bitbucketId = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'bitbucket',
        platform: 'bitbucket',
        repoFullName: 'team/old-name',
        bitbucketWorkspaceUuid: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
        bitbucketRepositoryUuid: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
      });

      const gitlab = await loadEnvironmentForSession(db, {
        owner,
        repository: { platform: 'gitlab', cloneUrl: 'https://gitlab.com/group/project.git' },
      });
      expect(gitlab?.layer.setupCommands).toEqual(['gitlab-setup']);
      expect(gitlab?.reference.environmentId).toBe(gitlabId);
      await expect(
        loadEnvironmentForSession(db, {
          owner,
          repository: { platform: 'gitlab', cloneUrl: 'https://gitlab.com/group/other.git' },
        })
      ).resolves.toBeNull();

      // The session path was renamed; the UUID pair still matches.
      const bitbucket = await loadEnvironmentForSession(db, {
        owner,
        repository: {
          platform: 'bitbucket',
          workspaceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          repositoryUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      });
      expect(bitbucket?.reference.environmentId).toBe(bitbucketId);
      expect(bitbucket?.layer.setupCommands).toEqual([]);
      await expect(
        loadEnvironmentForSession(db, {
          owner,
          repository: {
            platform: 'bitbucket',
            workspaceUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            repositoryUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          },
        })
      ).resolves.toBeNull();
    });
  });

  describe('configuration revision', () => {
    async function createRevisionEnv(userId: string): Promise<string> {
      return createEnv({
        owner: userOwner(userId),
        createdByUserId: userId,
        name: 'CI',
        platform: 'github',
        repoFullName: 'acme/widgets',
        plainVars: { PLAIN: 'one' },
        secrets: { TOKEN: 'secret-one' },
        commands: ['install'],
      });
    }

    test('starts at 1 and keeps the revision for a rename or identical writes', async () => {
      const user = await insertTestUser();
      const id = await createRevisionEnv(user.id);
      const owner = userOwner(user.id);
      expect((await getEnvironment(db, id, owner)).configurationRevision).toBe(1);

      await expect(updateEnv({ owner, environmentId: id, name: 'Renamed' })).resolves.toBe(1);
      await expect(
        updateEnv({
          owner,
          environmentId: id,
          plainVars: { PLAIN: 'one' },
          commands: ['install'],
          secrets: [],
        })
      ).resolves.toBe(1);
      await expect(
        updateEnv({ owner, environmentId: id, secrets: [{ key: 'ABSENT', delete: true }] })
      ).resolves.toBe(1);
      expect((await getEnvironment(db, id, owner)).configurationRevision).toBe(1);
    });

    test('advances for command, plaintext variable and secret changes', async () => {
      const user = await insertTestUser();
      const id = await createRevisionEnv(user.id);
      const owner = userOwner(user.id);

      await expect(
        updateEnv({ owner, environmentId: id, commands: ['install\nbuild'] })
      ).resolves.toBe(2);
      await expect(
        updateEnv({ owner, environmentId: id, plainVars: { PLAIN: 'two' } })
      ).resolves.toBe(3);
      // A submitted replacement counts even when its value is the same: the
      // stored value is encrypted and is never compared.
      await expect(
        updateEnv({ owner, environmentId: id, secrets: [{ key: 'TOKEN', value: 'secret-one' }] })
      ).resolves.toBe(4);
      await expect(
        updateEnv({ owner, environmentId: id, secrets: [{ key: 'TOKEN', delete: true }] })
      ).resolves.toBe(5);
      const summaries = await listEnvironmentsForOwner(db, owner);
      expect(summaries.find(summary => summary.id === id)?.configurationRevision).toBe(5);
    });

    test('reports the admitted reference and reads build inputs consistently', async () => {
      const user = await insertTestUser();
      const id = await createRevisionEnv(user.id);
      const owner = userOwner(user.id);
      await updateEnv({ owner, environmentId: id, commands: ['install\nbuild'] });

      const reference = (
        await loadEnvironmentForSession(db, {
          owner,
          repository: { platform: 'github', repoFullName: 'Acme/Widgets' },
        })
      )?.reference;
      expect(reference).toEqual({
        environmentId: id,
        owner,
        configurationRevision: 2,
        repository: { platform: 'github', repoFullName: 'acme/widgets' },
      });
      await expect(readEnvironmentReference(db, id)).resolves.toEqual(reference);

      const input = await loadEnvironmentBuildInput(db, id);
      expect(input).toMatchObject({
        reference,
        repoFullName: 'acme/widgets',
        commands: ['install\nbuild'],
        plainVars: { PLAIN: 'one' },
      });
      expect(Object.keys(input?.encryptedSecrets ?? {})).toEqual(['TOKEN']);
      expect(JSON.stringify(input)).not.toContain('secret-one');
    });

    test('reads nothing for a deleted environment or a deleted organization', async () => {
      const user = await insertTestUser();
      const id = await createRevisionEnv(user.id);
      await deleteEnvironment(db, id, userOwner(user.id));
      await expect(readEnvironmentReference(db, id)).resolves.toBeNull();
      await expect(loadEnvironmentBuildInput(db, id)).resolves.toBeNull();

      const organization = await createTestOrganization('Revision org', user.id, 0);
      const orgId = await createEnv({
        owner: { type: 'organization', id: organization.id },
        createdByUserId: user.id,
        name: 'org',
        platform: 'github',
        repoFullName: 'acme/widgets',
      });
      await db
        .update(organizations)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(organizations.id, organization.id));
      await expect(readEnvironmentReference(db, orgId)).resolves.toBeNull();
    });
  });

  describe('write limits', () => {
    test('rejects too many combined variables and secrets', async () => {
      const user = await insertTestUser();
      const plainVars = Object.fromEntries(
        Array.from({ length: ENVIRONMENT_LIMITS.MAX_VARS }, (_, index) => [`VAR_${index}`, 'v'])
      );

      await expect(
        createEnv({
          owner: userOwner(user.id),
          createdByUserId: user.id,
          name: 'too-many',
          platform: 'github',
          repoFullName: 'acme/widgets',
          plainVars,
          secrets: { ONE_MORE: 'v' },
        })
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    test('rejects an update that would exceed the cap before it issues any write', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const secrets = Object.fromEntries(
        Array.from({ length: ENVIRONMENT_LIMITS.MAX_VARS - 10 }, (_, index) => [
          `SECRET_${index}`,
          SECRET_PLAINTEXT,
        ])
      );
      const id = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'at-limit',
        platform: 'github',
        repoFullName: 'acme/at-limit',
        secrets,
      });
      const plainVars = Object.fromEntries(
        Array.from({ length: 11 }, (_, index) => [`VAR_${index}`, 'value'])
      );

      const statements: string[] = [];
      await expect(
        db.transaction(tx =>
          updateEnvironment(recordStatements(tx, statements), publicKeyBase64, {
            owner,
            environmentId: id,
            name: 'renamed',
            plainVars,
          })
        )
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: `Maximum ${ENVIRONMENT_LIMITS.MAX_VARS} variables and secrets allowed`,
      });

      expect(statements).toContain('select');
      expect(statements.filter(statement => statement !== 'select')).toEqual([]);
      const environment = await getEnvironment(db, id, owner);
      expect(environment.name).toBe('at-limit');
      expect(environment.plainVars).toEqual([]);
      expect(environment.secretKeys).toHaveLength(ENVIRONMENT_LIMITS.MAX_VARS - 10);
      expect(environment.configurationRevision).toBe(1);
    });

    test('rejects an oversized submission before it reads or writes', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const id = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'oversized',
        platform: 'github',
        repoFullName: 'acme/oversized',
        plainVars: { EXISTING: 'value' },
      });
      const plainVars = Object.fromEntries(
        Array.from({ length: ENVIRONMENT_LIMITS.MAX_VARS + 1 }, (_, index) => [
          `VAR_${index}`,
          'value',
        ])
      );

      const statements: string[] = [];
      await expect(
        db.transaction(tx =>
          updateEnvironment(recordStatements(tx, statements), publicKeyBase64, {
            owner,
            environmentId: id,
            plainVars,
          })
        )
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: `Maximum ${ENVIRONMENT_LIMITS.MAX_VARS} variables and secrets allowed`,
      });

      expect(statements).toEqual([]);
    });

    test('applies an update at the cap and replaces the whole set', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const half = ENVIRONMENT_LIMITS.MAX_VARS / 2;
      const plainVarsBefore = Object.fromEntries(
        Array.from({ length: half }, (_, index) => [`PLAIN_${index}`, 'before'])
      );
      const secretsBefore = Object.fromEntries(
        Array.from({ length: half }, (_, index) => [`SECRET_${index}`, 'before'])
      );
      const id = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'cap-update',
        platform: 'github',
        repoFullName: 'acme/cap-update',
        plainVars: plainVarsBefore,
        secrets: secretsBefore,
      });
      const plainVars = {
        ...Object.fromEntries(
          Array.from({ length: half - 1 }, (_, index) => [`PLAIN_${index + 1}`, 'after'])
        ),
        PLAIN_NEW: 'after',
      };
      const secrets = [
        ...Object.keys(secretsBefore).map(key => ({ key, delete: true as const })),
        ...Array.from({ length: half }, (_, index) => ({
          key: `REPLACEMENT_${index}`,
          value: 'after',
        })),
      ];

      const revision = await updateEnv({
        owner,
        environmentId: id,
        plainVars,
        secrets,
      });

      expect(revision).toBe(2);
      const input = await loadEnvironmentBuildInput(db, id);
      if (!input) throw new Error('expected a stored environment');
      expect(input.plainVars).toEqual(plainVars);
      const secretKeys = Object.keys(input.encryptedSecrets);
      expect(secretKeys).toHaveLength(half);
      expect(secretKeys).toEqual(
        expect.arrayContaining(Array.from({ length: half }, (_, index) => `REPLACEMENT_${index}`))
      );
      expect(decryptWithPrivateKey(input.encryptedSecrets.REPLACEMENT_0, privateKeyPem)).toBe(
        'after'
      );
    });

    test('a repeated key in one change list keeps the last entry', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const id = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'repeated-key',
        platform: 'github',
        repoFullName: 'acme/repeated-key',
      });

      await updateEnv({
        owner,
        environmentId: id,
        secrets: [
          { key: 'REPEATED', value: 'first' },
          { key: 'REPEATED', value: 'second' },
        ],
      });
      let input = await loadEnvironmentBuildInput(db, id);
      if (!input) throw new Error('expected a stored environment');
      expect(decryptWithPrivateKey(input.encryptedSecrets.REPEATED, privateKeyPem)).toBe('second');

      await updateEnv({
        owner,
        environmentId: id,
        secrets: [
          { key: 'REPEATED', delete: true },
          { key: 'REPEATED', value: 'third' },
        ],
      });
      input = await loadEnvironmentBuildInput(db, id);
      if (!input) throw new Error('expected a stored environment');
      expect(decryptWithPrivateKey(input.encryptedSecrets.REPEATED, privateKeyPem)).toBe('third');

      await updateEnv({
        owner,
        environmentId: id,
        secrets: [
          { key: 'REPEATED', value: 'fourth' },
          { key: 'REPEATED', delete: true },
        ],
      });
      input = await loadEnvironmentBuildInput(db, id);
      if (!input) throw new Error('expected a stored environment');
      expect(input.encryptedSecrets.REPEATED).toBeUndefined();
    });

    test('a secret added under a stored plaintext key converts it at the cap', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const id = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'converted',
        platform: 'github',
        repoFullName: 'acme/converted',
        plainVars: Object.fromEntries(
          Array.from({ length: ENVIRONMENT_LIMITS.MAX_VARS }, (_, index) => [
            `PLAIN_${index}`,
            'before',
          ])
        ),
      });

      const revision = await updateEnv({
        owner,
        environmentId: id,
        secrets: [{ key: 'PLAIN_0', value: 'converted' }],
      });

      expect(revision).toBe(2);
      const environment = await getEnvironment(db, id, owner);
      expect(environment.secretKeys).toEqual(['PLAIN_0']);
      expect(environment.plainVars).toHaveLength(ENVIRONMENT_LIMITS.MAX_VARS - 1);
      expect(environment.plainVars.map(variable => variable.key)).not.toContain('PLAIN_0');
    });

    test('a final delete of a repeated key leaves a plaintext variable in place', async () => {
      const user = await insertTestUser();
      const owner = userOwner(user.id);
      const id = await createEnv({
        owner,
        createdByUserId: user.id,
        name: 'repeated-delete',
        platform: 'github',
        repoFullName: 'acme/repeated-delete',
        plainVars: { KEPT: 'plain' },
      });

      const revision = await updateEnv({
        owner,
        environmentId: id,
        secrets: [
          { key: 'KEPT', value: 'transient' },
          { key: 'KEPT', delete: true },
        ],
      });

      expect(revision).toBe(1);
      const environment = await getEnvironment(db, id, owner);
      expect(environment.secretKeys).toEqual([]);
      expect(environment.plainVars.map(variable => variable.key)).toEqual(['KEPT']);
    });
  });
});

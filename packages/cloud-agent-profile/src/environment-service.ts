import type { WorkerDb } from '@kilocode/db';
import {
  cloud_agent_environments,
  cloud_agent_environment_vars,
  organizations,
  type CloudAgentEnvironment,
} from '@kilocode/db/schema';
import { and, count, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { encryptWithPublicKey } from '@kilocode/encryption';
import type { EnvironmentPlatform } from './environment-contracts';
import {
  encryptedEnvelopeSchema,
  assertValidEnvironmentKey,
  resolveEnvironmentIdentity,
  validateEnvironmentCommands,
  validateEnvironmentName,
  validateEnvironmentPlainVars,
  validateEnvironmentSecretValue,
  validateEnvironmentSecrets,
  validateEnvironmentVarCount,
  normalizeRepoFullName,
  normalizeBitbucketUuid,
  type EnvironmentBuildInput,
  type EnvironmentCreateInput,
  type EnvironmentForSession,
  type EnvironmentOwner,
  type EnvironmentReference,
  type EnvironmentRepositoryIdentity,
  type EnvironmentResponse,
  type EnvironmentSecretChange,
  type EnvironmentSummary,
  type EnvironmentUpdateInput,
} from './environment-contracts';

/** A transaction executor, derived from the worker database connection. */
export type EnvironmentTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

function buildEnvironmentOwnershipCondition(owner: EnvironmentOwner) {
  return owner.type === 'user'
    ? eq(cloud_agent_environments.owned_by_user_id, owner.id)
    : eq(cloud_agent_environments.owned_by_organization_id, owner.id);
}

/**
 * Lock an organization row and reject a missing or soft-deleted organization.
 * Callers own the surrounding transaction so the lock is held through the
 * environment write, closing the create/soft-delete race.
 */
export async function lockActiveOrganization(
  tx: EnvironmentTransaction,
  organizationId: string
): Promise<void> {
  const [organization] = await tx
    .select({ id: organizations.id, deletedAt: organizations.deleted_at })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for('update')
    .limit(1);

  if (!organization || organization.deletedAt) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Organization not found' });
  }
}

function assertNoPlainSecretCollision(
  plainVars: Record<string, string>,
  secretKeys: Iterable<string>
): void {
  const secretKeySet = new Set(secretKeys);
  for (const key of Object.keys(plainVars)) {
    if (secretKeySet.has(key)) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Environment variable "${key}" cannot be both plaintext and a secret`,
      });
    }
  }
}

function encryptValue(publicKeyBase64: string, value: string): string {
  if (!publicKeyBase64) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Agent environment encryption key not configured',
    });
  }
  const publicKey = Buffer.from(publicKeyBase64, 'base64');
  return JSON.stringify(encryptWithPublicKey(value, publicKey));
}

/**
 * The normalized identity a repository selection is matched against, expressed
 * as the stored columns every comparison must agree on. `identityCondition`
 * turns it into SQL, so the normalization lives in exactly one place.
 */
type EnvironmentRepositoryMatch = {
  platform: EnvironmentPlatform;
  columns: ReadonlyArray<{
    column: keyof Pick<
      CloudAgentEnvironment,
      | 'repo_full_name'
      | 'gitlab_clone_url'
      | 'bitbucket_workspace_uuid'
      | 'bitbucket_repository_uuid'
    >;
    value: string;
  }>;
};

function environmentRepositoryMatch(
  repository: EnvironmentRepositoryIdentity
): EnvironmentRepositoryMatch {
  switch (repository.platform) {
    case 'github':
      return {
        platform: 'github',
        columns: [
          { column: 'repo_full_name', value: normalizeRepoFullName(repository.repoFullName) },
        ],
      };
    case 'gitlab':
      return {
        platform: 'gitlab',
        columns: [{ column: 'gitlab_clone_url', value: repository.cloneUrl }],
      };
    case 'bitbucket':
      return {
        platform: 'bitbucket',
        columns: [
          {
            column: 'bitbucket_workspace_uuid',
            value: normalizeBitbucketUuid(repository.workspaceUuid),
          },
          {
            column: 'bitbucket_repository_uuid',
            value: normalizeBitbucketUuid(repository.repositoryUuid),
          },
        ],
      };
  }
}

function identityCondition(owner: EnvironmentOwner, repository: EnvironmentRepositoryIdentity) {
  const match = environmentRepositoryMatch(repository);
  return and(
    buildEnvironmentOwnershipCondition(owner),
    eq(cloud_agent_environments.platform, match.platform),
    ...match.columns.map(({ column, value }) => eq(cloud_agent_environments[column], value))
  );
}

function toResponseColumns(environment: CloudAgentEnvironment): {
  id: string;
  name: string;
  platform: EnvironmentPlatform;
  repoFullName: string;
  gitlabCloneUrl: string | null;
  bitbucketWorkspaceUuid: string | null;
  bitbucketRepositoryUuid: string | null;
  createdAt: string;
  updatedAt: string;
  configurationRevision: number;
  sandboxAllocation: string | null;
} {
  return {
    id: environment.id,
    name: environment.name,
    platform: environment.platform,
    repoFullName: environment.repo_full_name,
    gitlabCloneUrl: environment.gitlab_clone_url,
    bitbucketWorkspaceUuid: environment.bitbucket_workspace_uuid,
    bitbucketRepositoryUuid: environment.bitbucket_repository_uuid,
    createdAt: environment.created_at,
    updatedAt: environment.updated_at,
    configurationRevision: environment.configuration_revision,
    sandboxAllocation: environment.sandbox_allocation,
  };
}

function ownerOf(environment: CloudAgentEnvironment): EnvironmentOwner {
  if (environment.owned_by_organization_id !== null) {
    return { type: 'organization', id: environment.owned_by_organization_id };
  }
  if (environment.owned_by_user_id !== null) {
    return { type: 'user', id: environment.owned_by_user_id };
  }
  throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Environment has no owner' });
}

/** The stored repository identity, in the shape every comparison uses. */
function repositoryIdentityOf(environment: CloudAgentEnvironment): EnvironmentRepositoryIdentity {
  switch (environment.platform) {
    case 'github':
      return { platform: 'github', repoFullName: environment.repo_full_name };
    case 'gitlab':
      if (environment.gitlab_clone_url === null) break;
      return { platform: 'gitlab', cloneUrl: environment.gitlab_clone_url };
    case 'bitbucket':
      if (
        environment.bitbucket_workspace_uuid === null ||
        environment.bitbucket_repository_uuid === null
      ) {
        break;
      }
      return {
        platform: 'bitbucket',
        workspaceUuid: environment.bitbucket_workspace_uuid,
        repositoryUuid: environment.bitbucket_repository_uuid,
      };
  }
  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Environment repository identity is incomplete',
  });
}

function referenceOf(environment: CloudAgentEnvironment): EnvironmentReference {
  return {
    environmentId: environment.id,
    owner: ownerOf(environment),
    configurationRevision: environment.configuration_revision,
    repository: repositoryIdentityOf(environment),
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRecord(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every(key => Object.hasOwn(right, key) && right[key] === left[key])
  );
}

async function replacePlainVars(
  tx: EnvironmentTransaction,
  environmentId: string,
  plainVars: Record<string, string>
): Promise<void> {
  await tx
    .delete(cloud_agent_environment_vars)
    .where(
      and(
        eq(cloud_agent_environment_vars.environment_id, environmentId),
        eq(cloud_agent_environment_vars.is_secret, false)
      )
    );

  const rows = Object.entries(plainVars).map(([key, value]) => ({
    environment_id: environmentId,
    key,
    value,
    is_secret: false,
  }));
  if (rows.length > 0) {
    await tx.insert(cloud_agent_environment_vars).values(rows);
  }
}

/** Apply secret changes; returns whether any stored secret was replaced or removed. */
async function applySecretChanges(
  tx: EnvironmentTransaction,
  environmentId: string,
  publicKeyBase64: string,
  changes: EnvironmentSecretChange[]
): Promise<boolean> {
  // A later entry for the same key wins, which matches applying the list one at
  // a time and keeps the bulk upsert from touching one key twice.
  const finalChangeByKey = new Map<string, EnvironmentSecretChange>();
  for (const change of changes) {
    finalChangeByKey.set(change.key, change);
  }

  const deleteKeys: string[] = [];
  const upserts: Array<{ key: string; value: string }> = [];
  for (const change of finalChangeByKey.values()) {
    if ('delete' in change) {
      deleteKeys.push(change.key);
    } else {
      upserts.push(change);
    }
  }

  let changed = false;
  if (deleteKeys.length > 0) {
    const deleted = await tx
      .delete(cloud_agent_environment_vars)
      .where(
        and(
          eq(cloud_agent_environment_vars.environment_id, environmentId),
          inArray(cloud_agent_environment_vars.key, deleteKeys),
          eq(cloud_agent_environment_vars.is_secret, true)
        )
      )
      .returning({ id: cloud_agent_environment_vars.id });
    if (deleted.length > 0) changed = true;
  }

  if (upserts.length > 0) {
    changed = true;
    const updatedAt = new Date().toISOString();
    await tx
      .insert(cloud_agent_environment_vars)
      .values(
        upserts.map(change => ({
          environment_id: environmentId,
          key: change.key,
          value: encryptValue(publicKeyBase64, change.value),
          is_secret: true,
        }))
      )
      .onConflictDoUpdate({
        target: [cloud_agent_environment_vars.environment_id, cloud_agent_environment_vars.key],
        set: {
          value: sql`excluded.value`,
          is_secret: true,
          updated_at: updatedAt,
        },
      });
  }

  return changed;
}

async function countsFor(
  db: WorkerDb,
  environmentIds: string[]
): Promise<{
  plainVarCount: Map<string, number>;
  secretCount: Map<string, number>;
}> {
  if (environmentIds.length === 0) {
    return { plainVarCount: new Map(), secretCount: new Map() };
  }

  const varCounts = await db
    .select({
      environmentId: cloud_agent_environment_vars.environment_id,
      isSecret: cloud_agent_environment_vars.is_secret,
      count: count(),
    })
    .from(cloud_agent_environment_vars)
    .where(inArray(cloud_agent_environment_vars.environment_id, environmentIds))
    .groupBy(cloud_agent_environment_vars.environment_id, cloud_agent_environment_vars.is_secret);

  const plainVarCount = new Map<string, number>();
  const secretCount = new Map<string, number>();
  for (const row of varCounts) {
    const target = row.isSecret ? secretCount : plainVarCount;
    target.set(row.environmentId, Number(row.count));
  }

  return { plainVarCount, secretCount };
}

/**
 * Create a repository environment. The caller supplies the transaction so an
 * organization row can be locked through the whole write.
 */
export async function createEnvironment(
  tx: EnvironmentTransaction,
  publicKeyBase64: string,
  input: EnvironmentCreateInput
): Promise<{ id: string }> {
  const name = validateEnvironmentName(input.name);
  const identity = resolveEnvironmentIdentity(input);
  const plainVars = validateEnvironmentPlainVars(input.plainVars);
  const secrets = validateEnvironmentSecrets(input.secrets);
  const commands = validateEnvironmentCommands(input.commands);
  assertNoPlainSecretCollision(plainVars, Object.keys(secrets));
  validateEnvironmentVarCount(Object.keys(plainVars).length + Object.keys(secrets).length);

  if (input.owner.type === 'organization') {
    await lockActiveOrganization(tx, input.owner.id);
  }

  const [environment] = await tx
    .insert(cloud_agent_environments)
    .values({
      owned_by_user_id: input.owner.type === 'user' ? input.owner.id : null,
      owned_by_organization_id: input.owner.type === 'organization' ? input.owner.id : null,
      created_by_user_id: input.createdByUserId,
      name,
      platform: input.platform,
      ...identity,
      commands,
      sandbox_allocation: input.sandboxAllocation ?? null,
    })
    .returning({ id: cloud_agent_environments.id });

  if (!environment) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Environment creation failed' });
  }

  const variableValues = [
    ...Object.entries(plainVars).map(([key, value]) => ({
      environment_id: environment.id,
      key,
      value,
      is_secret: false,
    })),
    ...Object.entries(secrets).map(([key, value]) => ({
      environment_id: environment.id,
      key,
      value: encryptValue(publicKeyBase64, value),
      is_secret: true,
    })),
  ];
  if (variableValues.length > 0) {
    await tx.insert(cloud_agent_environment_vars).values(variableValues);
  }

  return { id: environment.id };
}

/**
 * Update an environment. Plain vars and commands are replaced when supplied;
 * secrets are an explicit change list and absent keys are retained.
 */
export async function updateEnvironment(
  tx: EnvironmentTransaction,
  publicKeyBase64: string,
  input: EnvironmentUpdateInput
): Promise<{ configurationRevision: number }> {
  const name = input.name === undefined ? undefined : validateEnvironmentName(input.name);
  const plainVars =
    input.plainVars === undefined ? undefined : validateEnvironmentPlainVars(input.plainVars);
  const commands =
    input.commands === undefined ? undefined : validateEnvironmentCommands(input.commands);
  const secretChanges = input.secrets;

  if (secretChanges !== undefined) {
    for (const change of secretChanges) {
      assertValidEnvironmentKey(change.key);
      if (!('delete' in change)) validateEnvironmentSecretValue(change.value);
    }
  }

  // Submitted additions can only raise the stored variable count, so this
  // bound rejects an oversized request before the transaction reaches the
  // database. The resulting count is checked once the stored rows are read.
  const addedSecretKeys = new Set(
    (secretChanges ?? []).filter(change => !('delete' in change)).map(change => change.key)
  );
  validateEnvironmentVarCount(Object.keys(plainVars ?? {}).length + addedSecretKeys.size);

  if (input.owner.type === 'organization') {
    await lockActiveOrganization(tx, input.owner.id);
  }

  const [environment] = await tx
    .select()
    .from(cloud_agent_environments)
    .where(
      and(
        eq(cloud_agent_environments.id, input.environmentId),
        buildEnvironmentOwnershipCondition(input.owner)
      )
    )
    .for('update')
    .limit(1);

  if (!environment) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' });
  }

  const changesVariables =
    plainVars !== undefined || (secretChanges !== undefined && secretChanges.length > 0);
  const storedVars = changesVariables
    ? await tx
        .select({
          key: cloud_agent_environment_vars.key,
          value: cloud_agent_environment_vars.value,
          isSecret: cloud_agent_environment_vars.is_secret,
        })
        .from(cloud_agent_environment_vars)
        .where(eq(cloud_agent_environment_vars.environment_id, input.environmentId))
    : [];
  const storedPlainVars = Object.fromEntries(
    storedVars.filter(row => !row.isSecret).map(row => [row.key, row.value])
  );
  const changedSecretKeys = new Set((secretChanges ?? []).map(change => change.key));
  const retainedSecretKeys = storedVars
    .filter(row => row.isSecret && !changedSecretKeys.has(row.key))
    .map(row => row.key);

  // The variable cap is decided from the resulting set, before the first
  // write, so one request cannot spend database work per submitted entry.
  if (changesVariables) {
    validateEnvironmentVarCount(
      (plainVars === undefined
        ? Object.keys(storedPlainVars).length
        : Object.keys(plainVars).length) +
        retainedSecretKeys.length +
        addedSecretKeys.size
    );
  }

  // Name and allocation are not build inputs; they never advance the revision.
  if (name !== undefined || input.sandboxAllocation !== undefined) {
    await tx
      .update(cloud_agent_environments)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(input.sandboxAllocation !== undefined
          ? { sandbox_allocation: input.sandboxAllocation }
          : {}),
      })
      .where(eq(cloud_agent_environments.id, input.environmentId));
  }

  // Build inputs change when the submitted commands or plaintext variables
  // differ from the stored ones, or when any secret is replaced or removed. A
  // submitted secret value is never compared: the stored value is encrypted.
  let buildInputsChanged = commands !== undefined && !sameStrings(commands, environment.commands);
  if (plainVars !== undefined && !buildInputsChanged) {
    buildInputsChanged = !sameRecord(plainVars, storedPlainVars);
  }

  if (plainVars !== undefined) {
    assertNoPlainSecretCollision(plainVars, [...retainedSecretKeys, ...addedSecretKeys]);
  }

  // Secret changes run before the plaintext replacement so a deleted secret
  // frees its key for a plaintext variable of the same name.
  if (secretChanges !== undefined && secretChanges.length > 0) {
    if (await applySecretChanges(tx, input.environmentId, publicKeyBase64, secretChanges)) {
      buildInputsChanged = true;
    }
  }

  if (plainVars !== undefined) {
    await replacePlainVars(tx, input.environmentId, plainVars);
  }

  if (commands !== undefined) {
    await tx
      .update(cloud_agent_environments)
      .set({ commands })
      .where(eq(cloud_agent_environments.id, input.environmentId));
  }

  // The cap is enforced above from the resulting set; this keeps the stored
  // rows as the last word for a set that predates the limit.
  const rows = await tx
    .select({ key: cloud_agent_environment_vars.key })
    .from(cloud_agent_environment_vars)
    .where(eq(cloud_agent_environment_vars.environment_id, input.environmentId));
  validateEnvironmentVarCount(rows.length);

  if (!buildInputsChanged) return { configurationRevision: environment.configuration_revision };
  // The row is locked FOR UPDATE above, so the increment is serialized with
  // every other edit of this environment.
  const [updated] = await tx
    .update(cloud_agent_environments)
    .set({ configuration_revision: sql`${cloud_agent_environments.configuration_revision} + 1` })
    .where(eq(cloud_agent_environments.id, input.environmentId))
    .returning({ configurationRevision: cloud_agent_environments.configuration_revision });
  if (!updated) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' });
  }
  return { configurationRevision: updated.configurationRevision };
}

export async function deleteEnvironment(
  db: WorkerDb,
  environmentId: string,
  owner: EnvironmentOwner
): Promise<void> {
  const rows = await db
    .delete(cloud_agent_environments)
    .where(
      and(eq(cloud_agent_environments.id, environmentId), buildEnvironmentOwnershipCondition(owner))
    )
    .returning({ id: cloud_agent_environments.id });

  if (rows.length === 0) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' });
  }
}

export async function getEnvironment(
  db: WorkerDb,
  environmentId: string,
  owner: EnvironmentOwner
): Promise<EnvironmentResponse> {
  const [environment] = await db
    .select()
    .from(cloud_agent_environments)
    .where(
      and(eq(cloud_agent_environments.id, environmentId), buildEnvironmentOwnershipCondition(owner))
    )
    .limit(1);

  if (!environment) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' });
  }

  const [plainVars, secretKeys] = await Promise.all([
    db
      .select({
        key: cloud_agent_environment_vars.key,
        value: cloud_agent_environment_vars.value,
        createdAt: cloud_agent_environment_vars.created_at,
        updatedAt: cloud_agent_environment_vars.updated_at,
      })
      .from(cloud_agent_environment_vars)
      .where(
        and(
          eq(cloud_agent_environment_vars.environment_id, environmentId),
          eq(cloud_agent_environment_vars.is_secret, false)
        )
      )
      .orderBy(cloud_agent_environment_vars.key),
    db
      .select({ key: cloud_agent_environment_vars.key })
      .from(cloud_agent_environment_vars)
      .where(
        and(
          eq(cloud_agent_environment_vars.environment_id, environmentId),
          eq(cloud_agent_environment_vars.is_secret, true)
        )
      )
      .orderBy(cloud_agent_environment_vars.key),
  ]);

  return {
    ...toResponseColumns(environment),
    plainVars,
    commands: environment.commands,
    secretKeys: secretKeys.map(row => row.key),
  };
}

async function summarizeEnvironments(
  db: WorkerDb,
  environments: CloudAgentEnvironment[]
): Promise<EnvironmentSummary[]> {
  if (environments.length === 0) return [];

  const { plainVarCount, secretCount } = await countsFor(
    db,
    environments.map(environment => environment.id)
  );

  return environments.map(environment => ({
    ...toResponseColumns(environment),
    plainVarCount: plainVarCount.get(environment.id) ?? 0,
    secretCount: secretCount.get(environment.id) ?? 0,
    commandCount: environment.commands.length,
  }));
}

export async function listEnvironments(
  db: WorkerDb,
  owner: EnvironmentOwner,
  repository: EnvironmentRepositoryIdentity
): Promise<EnvironmentSummary[]> {
  const environments = await db
    .select()
    .from(cloud_agent_environments)
    .where(identityCondition(owner, repository))
    .orderBy(cloud_agent_environments.name, cloud_agent_environments.id);

  return summarizeEnvironments(db, environments);
}

/** List every environment an owner has, across all repositories. */
export async function listEnvironmentsForOwner(
  db: WorkerDb,
  owner: EnvironmentOwner
): Promise<EnvironmentSummary[]> {
  const environments = await db
    .select()
    .from(cloud_agent_environments)
    .where(buildEnvironmentOwnershipCondition(owner))
    .orderBy(cloud_agent_environments.name, cloud_agent_environments.id);

  return summarizeEnvironments(db, environments);
}

/** Split variable rows into plaintext values and parsed secret envelopes. */
function splitVariables(vars: ReadonlyArray<{ key: string; value: string; isSecret: boolean }>): {
  plainVars: Record<string, string>;
  encryptedSecrets: EnvironmentBuildInput['encryptedSecrets'];
} {
  const plainVars: Record<string, string> = {};
  const encryptedSecrets: EnvironmentBuildInput['encryptedSecrets'] = {};
  for (const variable of vars) {
    if (variable.isSecret) {
      encryptedSecrets[variable.key] = encryptedEnvelopeSchema.parse(JSON.parse(variable.value));
    } else {
      plainVars[variable.key] = variable.value;
    }
  }
  return { plainVars, encryptedSecrets };
}

async function readVariables(db: Pick<WorkerDb, 'select'>, environmentId: string) {
  return db
    .select({
      key: cloud_agent_environment_vars.key,
      value: cloud_agent_environment_vars.value,
      isSecret: cloud_agent_environment_vars.is_secret,
    })
    .from(cloud_agent_environment_vars)
    .where(eq(cloud_agent_environment_vars.environment_id, environmentId))
    .orderBy(cloud_agent_environment_vars.key);
}

/** The matching environment row when its owning organization is active. */
async function readActiveEnvironment(
  db: Pick<WorkerDb, 'select'>,
  condition: SQL | undefined
): Promise<CloudAgentEnvironment | null> {
  const [row] = await db
    .select({ environment: cloud_agent_environments })
    .from(cloud_agent_environments)
    .leftJoin(
      organizations,
      eq(cloud_agent_environments.owned_by_organization_id, organizations.id)
    )
    .where(and(condition, isNull(organizations.deleted_at)))
    .limit(1);
  return row?.environment ?? null;
}

/**
 * Load the environment of a session's repository: the primitives the session
 * merges, the authorized reference that travels beside them, and the saved
 * allocation. Null when the owner has no environment for the repository or the
 * owning organization is soft-deleted. An owner has at most one environment
 * per repository.
 */
export async function loadEnvironmentForSession(
  db: WorkerDb,
  input: { owner: EnvironmentOwner; repository: EnvironmentRepositoryIdentity }
): Promise<EnvironmentForSession | null> {
  return db.transaction(
    async tx => {
      const environment = await readActiveEnvironment(
        tx,
        identityCondition(input.owner, input.repository)
      );
      if (!environment) return null;

      const { plainVars, encryptedSecrets } = splitVariables(
        await readVariables(tx, environment.id)
      );
      return {
        layer: {
          envVars: plainVars,
          encryptedSecrets,
          setupCommands: environment.commands,
        },
        reference: referenceOf(environment),
        sandboxAllocation: environment.sandbox_allocation,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}

/**
 * The current owner, revision and repository of an environment, or null when
 * it no longer exists or its owning organization is deleted. Build admission
 * and publication recheck this before acting.
 */
export async function readEnvironmentReference(
  db: WorkerDb,
  environmentId: string
): Promise<EnvironmentReference | null> {
  const environment = await readActiveEnvironment(
    db,
    eq(cloud_agent_environments.id, environmentId)
  );
  return environment === null ? null : referenceOf(environment);
}

/**
 * Read one build's inputs consistently: the environment row and its variable
 * rows come from one repeatable-read snapshot, so a concurrent edit cannot mix
 * two revisions. Secrets stay encrypted envelopes. Null when the environment
 * no longer exists.
 */
export async function loadEnvironmentBuildInput(
  db: WorkerDb,
  environmentId: string
): Promise<EnvironmentBuildInput | null> {
  return db.transaction(
    async tx => {
      const environment = await readActiveEnvironment(
        tx,
        eq(cloud_agent_environments.id, environmentId)
      );
      if (environment === null) return null;
      const { plainVars, encryptedSecrets } = splitVariables(
        await readVariables(tx, environmentId)
      );
      return {
        reference: referenceOf(environment),
        repoFullName: environment.repo_full_name,
        commands: environment.commands,
        plainVars,
        encryptedSecrets,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}

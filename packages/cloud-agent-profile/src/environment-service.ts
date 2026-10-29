import type { WorkerDb } from '@kilocode/db';
import {
  cloud_agent_environments,
  cloud_agent_environment_vars,
  organizations,
  type CloudAgentEnvironment,
} from '@kilocode/db/schema';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { encryptWithPublicKey } from '@kilocode/encryption';
import {
  encryptedEnvelopeSchema,
  assertValidEnvironmentKey,
  validateEnvironmentCommands,
  validateEnvironmentName,
  validateEnvironmentPlainVars,
  validateEnvironmentSecretValue,
  validateEnvironmentSecrets,
  validateEnvironmentVarCount,
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
import {
  buildEnvironmentOwnershipCondition,
  selectActiveEnvironments,
  selectEnvironmentForSession,
  selectEnvironmentsContainingRepository,
  type EnvironmentSelection,
} from './environment-lookup';
import {
  identityResponseOf,
  planRepositoriesUpdate,
  readRepositories,
  referenceOf as referenceWithOwner,
  referenceRepositoryOf,
  repositoryColumnsOfCreate,
  repositoryPathOf,
} from './environment-repositories';

/** A transaction executor, derived from the worker database connection. */
export type EnvironmentTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

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

function toBaseResponseColumns(environment: CloudAgentEnvironment): {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  configurationRevision: number;
  sandboxAllocation: string | null;
} {
  return {
    id: environment.id,
    name: environment.name,
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

function referenceOf(environment: CloudAgentEnvironment): EnvironmentReference {
  return referenceWithOwner(environment, ownerOf(environment));
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

  for (const [key, value] of Object.entries(plainVars)) {
    await tx
      .insert(cloud_agent_environment_vars)
      .values({ environment_id: environmentId, key, value, is_secret: false });
  }
}

/** Apply secret changes; returns whether any stored secret was replaced or removed. */
async function applySecretChanges(
  tx: EnvironmentTransaction,
  environmentId: string,
  publicKeyBase64: string,
  changes: EnvironmentSecretChange[]
): Promise<boolean> {
  let changed = false;
  for (const change of changes) {
    if ('delete' in change) {
      const deleted = await tx
        .delete(cloud_agent_environment_vars)
        .where(
          and(
            eq(cloud_agent_environment_vars.environment_id, environmentId),
            eq(cloud_agent_environment_vars.key, change.key),
            eq(cloud_agent_environment_vars.is_secret, true)
          )
        )
        .returning({ id: cloud_agent_environment_vars.id });
      if (deleted.length > 0) changed = true;
      continue;
    }
    changed = true;

    const encryptedValue = encryptValue(publicKeyBase64, change.value);
    await tx
      .insert(cloud_agent_environment_vars)
      .values({
        environment_id: environmentId,
        key: change.key,
        value: encryptedValue,
        is_secret: true,
      })
      .onConflictDoUpdate({
        target: [cloud_agent_environment_vars.environment_id, cloud_agent_environment_vars.key],
        set: {
          value: encryptedValue,
          is_secret: true,
          updated_at: new Date().toISOString(),
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
  const repositoryColumns = repositoryColumnsOfCreate(input);
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
      ...repositoryColumns,
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

  const repositoriesUpdate =
    input.repositories === undefined
      ? undefined
      : planRepositoriesUpdate(environment, input.repositories);

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

  if (secretChanges !== undefined) {
    for (const change of secretChanges) {
      assertValidEnvironmentKey(change.key);
      if (!('delete' in change)) validateEnvironmentSecretValue(change.value);
    }
  }

  // Build inputs change when the submitted commands or plaintext variables
  // differ from the stored ones, or when any secret is replaced or removed. A
  // submitted secret value is never compared: the stored value is encrypted.
  let buildInputsChanged =
    repositoriesUpdate?.changed === true ||
    (commands !== undefined && !sameStrings(commands, environment.commands));
  if (plainVars !== undefined && !buildInputsChanged) {
    const storedPlainRows = await tx
      .select({ key: cloud_agent_environment_vars.key, value: cloud_agent_environment_vars.value })
      .from(cloud_agent_environment_vars)
      .where(
        and(
          eq(cloud_agent_environment_vars.environment_id, input.environmentId),
          eq(cloud_agent_environment_vars.is_secret, false)
        )
      );
    const storedPlainVars = Object.fromEntries(storedPlainRows.map(row => [row.key, row.value]));
    buildInputsChanged = !sameRecord(plainVars, storedPlainVars);
  }

  if (plainVars !== undefined) {
    const existingSecretRows = await tx
      .select({ key: cloud_agent_environment_vars.key })
      .from(cloud_agent_environment_vars)
      .where(
        and(
          eq(cloud_agent_environment_vars.environment_id, input.environmentId),
          eq(cloud_agent_environment_vars.is_secret, true)
        )
      );
    const changedKeys = new Set((secretChanges ?? []).map(change => change.key));
    const retainedSecretKeys = existingSecretRows
      .map(row => row.key)
      .filter(key => !changedKeys.has(key));
    const newSecretKeys = (secretChanges ?? [])
      .filter(change => !('delete' in change))
      .map(change => change.key);
    assertNoPlainSecretCollision(plainVars, [...retainedSecretKeys, ...newSecretKeys]);
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

  if (repositoriesUpdate?.changed) {
    await tx
      .update(cloud_agent_environments)
      .set({ repositories: repositoriesUpdate.repositories })
      .where(eq(cloud_agent_environments.id, input.environmentId));
  }

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
    ...toBaseResponseColumns(environment),
    ...identityResponseOf(environment),
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
    ...toBaseResponseColumns(environment),
    ...identityResponseOf(environment),
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
  const environments = await selectEnvironmentsContainingRepository(db, owner, repository);
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

/** The environment row with this id when its owning organization is active. */
async function readActiveEnvironment(
  db: Pick<WorkerDb, 'select'>,
  environmentId: string
): Promise<CloudAgentEnvironment | null> {
  const [environment] = await selectActiveEnvironments(
    db,
    eq(cloud_agent_environments.id, environmentId)
  );
  return environment ?? null;
}

/**
 * The outcome of resolving a session's environment. `none`, `conflict` and the
 * two `requested-*` statuses carry no environment: the caller decides whether
 * each fails the session or runs it with no environment.
 */
export type EnvironmentSessionResolution =
  | { status: 'match'; environment: EnvironmentForSession }
  | Exclude<EnvironmentSelection, { status: 'match' }>;

/**
 * Load the environment of a session's launch repository: the primitives the
 * session merges, the authorized reference that travels beside them, and the saved
 * allocation. A V1 environment matches by its identity columns and a V2
 * environment by containment of the repository.
 *
 * With `environmentId`, only that environment is considered. Without one, several
 * matches are a `conflict` and no environment is chosen.
 */
export async function loadEnvironmentForSession(
  db: WorkerDb,
  input: {
    owner: EnvironmentOwner;
    repository: EnvironmentRepositoryIdentity;
    environmentId?: string;
  }
): Promise<EnvironmentSessionResolution> {
  return db.transaction(
    async tx => {
      const selection = await selectEnvironmentForSession(tx, input);
      if (selection.status !== 'match') return selection;

      const { environment } = selection;
      const { plainVars, encryptedSecrets } = splitVariables(
        await readVariables(tx, environment.id)
      );
      const repositories = readRepositories(environment);
      return {
        status: 'match',
        environment: {
          layer: {
            envVars: plainVars,
            encryptedSecrets,
            setupCommands: environment.commands,
            ...(repositories ? { repositories: repositories.map(referenceRepositoryOf) } : {}),
          },
          reference: referenceOf(environment),
          sandboxAllocation: environment.sandbox_allocation,
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}

/**
 * The current owner, revision and repositories of an environment, or null when
 * it no longer exists or its owning organization is deleted. Build admission
 * and publication recheck this before acting.
 */
export async function readEnvironmentReference(
  db: WorkerDb,
  environmentId: string
): Promise<EnvironmentReference | null> {
  const environment = await readActiveEnvironment(db, environmentId);
  return environment === null ? null : referenceOf(environment);
}

/**
 * Read one build's inputs consistently: the environment row and its variable
 * rows come from one repeatable-read snapshot, so a concurrent edit cannot mix
 * two revisions. Secrets stay encrypted envelopes. Null when the environment
 * no longer exists. A V2 build lists every repository and has no launch one.
 */
export async function loadEnvironmentBuildInput(
  db: WorkerDb,
  environmentId: string
): Promise<EnvironmentBuildInput | null> {
  return db.transaction(
    async tx => {
      const environment = await readActiveEnvironment(tx, environmentId);
      if (environment === null) return null;
      const { plainVars, encryptedSecrets } = splitVariables(
        await readVariables(tx, environmentId)
      );
      const reference = referenceOf(environment);
      const common = { reference, commands: environment.commands, plainVars, encryptedSecrets };
      return reference.repositories
        ? { ...common, repositories: reference.repositories }
        : { ...common, repoFullName: repositoryPathOf(environment) };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}

import type { WorkerDb } from '@kilocode/db';
import {
  cloud_agent_environments,
  cloud_agent_environment_vars,
  organizations,
  type CloudAgentEnvironment,
} from '@kilocode/db/schema';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
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
  type EnvironmentCreateInput,
  type EnvironmentForSession,
  type EnvironmentOwner,
  type EnvironmentRepositoryIdentity,
  type EnvironmentResponse,
  type EnvironmentSecretChange,
  type EnvironmentSessionLayer,
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
    sandboxAllocation: environment.sandbox_allocation,
  };
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

async function applySecretChanges(
  tx: EnvironmentTransaction,
  environmentId: string,
  publicKeyBase64: string,
  changes: EnvironmentSecretChange[]
): Promise<void> {
  for (const change of changes) {
    if ('delete' in change) {
      await tx
        .delete(cloud_agent_environment_vars)
        .where(
          and(
            eq(cloud_agent_environment_vars.environment_id, environmentId),
            eq(cloud_agent_environment_vars.key, change.key),
            eq(cloud_agent_environment_vars.is_secret, true)
          )
        );
      continue;
    }

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
): Promise<void> {
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
  if (secretChanges !== undefined) {
    await applySecretChanges(tx, input.environmentId, publicKeyBase64, secretChanges);
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

  const rows = await tx
    .select({ key: cloud_agent_environment_vars.key })
    .from(cloud_agent_environment_vars)
    .where(eq(cloud_agent_environment_vars.environment_id, input.environmentId));
  validateEnvironmentVarCount(rows.length);
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

/**
 * Load the environment of a session's repository: the primitives the session
 * merges and the saved allocation. Null when the owner has no environment for
 * the repository or the owning organization is soft-deleted. An owner has at
 * most one environment per repository.
 */
export async function loadEnvironmentForSession(
  db: WorkerDb,
  input: { owner: EnvironmentOwner; repository: EnvironmentRepositoryIdentity }
): Promise<EnvironmentForSession | null> {
  const [row] = await db
    .select({ environment: cloud_agent_environments })
    .from(cloud_agent_environments)
    .leftJoin(
      organizations,
      eq(cloud_agent_environments.owned_by_organization_id, organizations.id)
    )
    .where(and(identityCondition(input.owner, input.repository), isNull(organizations.deleted_at)))
    .limit(1);
  if (!row) return null;

  const vars = await db
    .select({
      key: cloud_agent_environment_vars.key,
      value: cloud_agent_environment_vars.value,
      isSecret: cloud_agent_environment_vars.is_secret,
    })
    .from(cloud_agent_environment_vars)
    .where(eq(cloud_agent_environment_vars.environment_id, row.environment.id));

  const envVars: Record<string, string> = {};
  const encryptedSecrets: EnvironmentSessionLayer['encryptedSecrets'] = {};
  for (const variable of vars) {
    if (variable.isSecret) {
      encryptedSecrets[variable.key] = encryptedEnvelopeSchema.parse(JSON.parse(variable.value));
    } else {
      envVars[variable.key] = variable.value;
    }
  }

  return {
    layer: { envVars, encryptedSecrets, setupCommands: row.environment.commands },
    sandboxAllocation: row.environment.sandbox_allocation,
  };
}

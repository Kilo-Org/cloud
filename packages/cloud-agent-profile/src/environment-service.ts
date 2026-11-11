import type { WorkerDb } from '@kilocode/db';
import {
  cloud_agent_environment_setup_runs,
  cloud_agent_environments,
  cloud_agent_environment_vars,
  organizations,
  type CloudAgentEnvironment,
} from '@kilocode/db/schema';
import { and, count, eq, inArray, or, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { encryptWithPublicKey } from '@kilocode/encryption';
import {
  egressDomainSchema,
  egressPolicySchema,
  type EgressMode,
} from '@kilocode/worker-utils/egress-allowlist';
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
  setupRunOwnershipCondition,
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
import {
  ENVIRONMENT_SETUP_LIMITS,
  isOpenSetupRunStatus,
  OPEN_SETUP_RUN_STATUSES,
} from './environment-setup-contracts';

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

type EnvironmentEgressColumns = {
  egress_mode: EgressMode;
  egress_allowlist: string[] | null;
};

/**
 * Validates a supplied network policy with the shared egress contract and
 * converts it to the stored columns. Absent mode retains the stored policy.
 * Allowlist mode always stores a list, so the "None" choice is an empty one.
 */
function resolveEnvironmentEgressPolicy(input: {
  egressMode?: EgressMode;
  egressAllowlist?: string[];
}): EnvironmentEgressColumns | undefined {
  if (input.egressMode === undefined) {
    if (input.egressAllowlist !== undefined) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'egressAllowlist requires egressMode to be allowlist',
      });
    }
    return undefined;
  }

  const parsed = egressPolicySchema.safeParse({
    egressMode: input.egressMode,
    egressAllowlist: input.egressAllowlist,
  });
  if (!parsed.success) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid egress policy' });
  }

  return parsed.data.egressMode === 'allowlist'
    ? { egress_mode: 'allowlist', egress_allowlist: parsed.data.egressAllowlist ?? [] }
    : { egress_mode: 'unrestricted', egress_allowlist: null };
}

/**
 * Validates required hosts with the shared hostname contract and returns the
 * stored form: lowercased, in submitted order, without duplicates.
 */
function resolveEnvironmentRequiredHosts(
  requiredHosts: string[] | undefined
): string[] | undefined {
  if (requiredHosts === undefined) return undefined;

  const parsed: string[] = [];
  for (const host of requiredHosts) {
    const result = egressDomainSchema.safeParse(host);
    if (!result.success) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `Invalid required network host: ${host}`,
      });
    }
    if (!parsed.includes(result.data)) parsed.push(result.data);
  }

  if (parsed.length > ENVIRONMENT_SETUP_LIMITS.MAX_REQUIRED_HOSTS) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `At most ${ENVIRONMENT_SETUP_LIMITS.MAX_REQUIRED_HOSTS} required network hosts are allowed`,
    });
  }

  return parsed;
}

/**
 * The effective allowlist of a restricted policy is the user's allowed hosts
 * plus the required hosts, so the shared egress cap covers both.
 */
export function assertEffectiveAllowlistWithinLimit(
  allowedHosts: readonly string[],
  requiredHosts: readonly string[]
): void {
  if (
    new Set([...allowedHosts, ...requiredHosts]).size >
    ENVIRONMENT_SETUP_LIMITS.MAX_EFFECTIVE_ALLOWLIST
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Required hosts and allowed hosts together exceed 100 hostnames',
    });
  }
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

/**
 * The last entry for a key wins, so a change list may repeat a key and the
 * bulk statements never touch one key twice. A final delete removes a stored
 * secret of that key; it leaves a plaintext variable of the same name alone.
 */
function finalSecretChangeByKey(
  changes: readonly EnvironmentSecretChange[]
): Map<string, EnvironmentSecretChange> {
  const byKey = new Map<string, EnvironmentSecretChange>();
  for (const change of changes) {
    byKey.set(change.key, change);
  }
  return byKey;
}

/** Apply secret changes; returns whether any stored secret was replaced or removed. */
async function applySecretChanges(
  tx: EnvironmentTransaction,
  environmentId: string,
  publicKeyBase64: string,
  changes: EnvironmentSecretChange[]
): Promise<boolean> {
  const finalChangeByKey = finalSecretChangeByKey(changes);

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
  const repositoryColumns = repositoryColumnsOfCreate(input);
  const plainVars = validateEnvironmentPlainVars(input.plainVars);
  const secrets = validateEnvironmentSecrets(input.secrets);
  const commands = validateEnvironmentCommands(input.commands);
  const startCommands = validateEnvironmentCommands(input.startCommands, 'Start');
  assertNoPlainSecretCollision(plainVars, Object.keys(secrets));
  validateEnvironmentVarCount(Object.keys(plainVars).length + Object.keys(secrets).length);
  const egress = resolveEnvironmentEgressPolicy(input);

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
      start_commands: startCommands,
      sandbox_allocation: input.sandboxAllocation ?? null,
      egress_mode: egress?.egress_mode ?? null,
      egress_allowlist: egress?.egress_allowlist ?? null,
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
  const startCommands =
    input.startCommands === undefined
      ? undefined
      : validateEnvironmentCommands(input.startCommands, 'Start');
  const secretChanges = input.secrets;
  const egress = resolveEnvironmentEgressPolicy(input);
  const requiredHosts = resolveEnvironmentRequiredHosts(input.requiredHosts);

  if (secretChanges !== undefined) {
    for (const change of secretChanges) {
      assertValidEnvironmentKey(change.key);
      if (!('delete' in change)) validateEnvironmentSecretValue(change.value);
    }
  }

  const finalSecretChanges = finalSecretChangeByKey(secretChanges ?? []);
  const addedSecretKeys = [...finalSecretChanges.values()]
    .filter(change => !('delete' in change))
    .map(change => change.key);
  // Submitted additions can only raise the stored variable count, so this
  // bound rejects an oversized request before the transaction reaches the
  // database. The resulting count is checked once the stored rows are read.
  validateEnvironmentVarCount(Object.keys(plainVars ?? {}).length + addedSecretKeys.length);

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

  if (
    environment.is_draft &&
    environment.draft_for_environment_id !== null &&
    (input.egressMode !== undefined || input.egressAllowlist !== undefined)
  ) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Change the network policy on the target environment',
    });
  }

  if (requiredHosts !== undefined || egress !== undefined) {
    const allowedHosts =
      egress === undefined ? (environment.egress_allowlist ?? []) : (egress.egress_allowlist ?? []);
    assertEffectiveAllowlistWithinLimit(
      allowedHosts,
      requiredHosts ?? environment.egress_required_hosts ?? []
    );
  }

  const changesVariables =
    plainVars !== undefined || (secretChanges !== undefined && secretChanges.length > 0);
  const storedVars = changesVariables
    ? await tx
        .select({
          key: cloud_agent_environment_vars.key,
          // Only plaintext values are compared, so secret envelopes stay out of
          // the row payload.
          plainValue: sql<
            string | null
          >`case when ${cloud_agent_environment_vars.is_secret} then null else ${cloud_agent_environment_vars.value} end`,
          isSecret: cloud_agent_environment_vars.is_secret,
        })
        .from(cloud_agent_environment_vars)
        .where(eq(cloud_agent_environment_vars.environment_id, input.environmentId))
    : [];
  const storedPlainVars: Record<string, string> = {};
  for (const row of storedVars) {
    if (!row.isSecret && row.plainValue !== null) {
      storedPlainVars[row.key] = row.plainValue;
    }
  }
  const storedPlainKeys = new Set(Object.keys(storedPlainVars));
  const changedSecretKeys = new Set(finalSecretChanges.keys());
  const retainedSecretKeys = storedVars
    .filter(row => row.isSecret && !changedSecretKeys.has(row.key))
    .map(row => row.key);

  // The variable cap is decided from the resulting set, before the first
  // write, so one request cannot spend database work per submitted entry.
  if (changesVariables) {
    // An added secret under a stored plaintext key reuses that row instead of
    // adding one, and a plaintext replacement drops keys it does not carry.
    const reusedPlainKeys =
      plainVars === undefined ? addedSecretKeys.filter(key => storedPlainKeys.has(key)).length : 0;
    validateEnvironmentVarCount(
      (plainVars === undefined
        ? storedPlainKeys.size - reusedPlainKeys
        : Object.keys(plainVars).length) +
        retainedSecretKeys.length +
        addedSecretKeys.length
    );
  }
  const repositoriesUpdate =
    input.repositories === undefined
      ? undefined
      : planRepositoriesUpdate(environment, input.repositories);

  // Name, allocation and network policy are not build inputs; they never advance the revision.
  if (name !== undefined || input.sandboxAllocation !== undefined || egress !== undefined) {
    await tx
      .update(cloud_agent_environments)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(input.sandboxAllocation !== undefined
          ? { sandbox_allocation: input.sandboxAllocation }
          : {}),
        ...(egress !== undefined
          ? { egress_mode: egress.egress_mode, egress_allowlist: egress.egress_allowlist }
          : {}),
      })
      .where(eq(cloud_agent_environments.id, input.environmentId));
  }

  // Build inputs change when the submitted commands or plaintext variables
  // differ from the stored ones, or when any secret is replaced or removed. A
  // submitted secret value is never compared: the stored value is encrypted.
  let buildInputsChanged =
    repositoriesUpdate?.changed === true ||
    (commands !== undefined && !sameStrings(commands, environment.commands));
  if (plainVars !== undefined && !buildInputsChanged) {
    buildInputsChanged = !sameRecord(plainVars, storedPlainVars);
  }

  if (requiredHosts !== undefined && !buildInputsChanged) {
    buildInputsChanged = !sameStrings(requiredHosts, environment.egress_required_hosts ?? []);
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

  // Start commands never run in a build, so they never advance the revision.
  if (startCommands !== undefined) {
    await tx
      .update(cloud_agent_environments)
      .set({ start_commands: startCommands })
      .where(eq(cloud_agent_environments.id, input.environmentId));
  }

  if (requiredHosts !== undefined) {
    await tx
      .update(cloud_agent_environments)
      .set({ egress_required_hosts: requiredHosts })
      .where(eq(cloud_agent_environments.id, input.environmentId));
  }

  if (repositoriesUpdate?.changed) {
    await tx
      .update(cloud_agent_environments)
      .set({
        repositories: repositoriesUpdate.repositories,
        platform: null,
        repo_full_name: null,
        gitlab_clone_url: null,
        bitbucket_workspace_uuid: null,
        bitbucket_repository_uuid: null,
      })
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
  await db.transaction(async tx => {
    if (owner.type === 'organization') {
      await lockActiveOrganization(tx, owner.id);
    }

    const runs = cloud_agent_environment_setup_runs;
    const openRuns = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          inArray(runs.status, [...OPEN_SETUP_RUN_STATUSES]),
          or(
            eq(runs.draft_environment_id, environmentId),
            eq(runs.target_environment_id, environmentId)
          )
        )
      )
      .for('update');

    const rows = await tx
      .delete(cloud_agent_environments)
      .where(
        and(
          eq(cloud_agent_environments.id, environmentId),
          buildEnvironmentOwnershipCondition(owner)
        )
      )
      .returning({ id: cloud_agent_environments.id });

    // A setup run cannot continue without its draft or its target. Cancel after the
    // delete: cancelling first made deleting a target fail with a draft foreign-key
    // violation during the cascade (see the target deletion test).
    if (openRuns.length > 0) {
      await tx
        .update(runs)
        .set({
          status: 'cancelled',
          data: sql`${runs.data} || '{"status_reason":"draft_deleted"}'::jsonb`,
          completed_at: new Date().toISOString(),
        })
        .where(
          inArray(
            runs.id,
            openRuns.map(run => run.id)
          )
        );
    }

    if (rows.length === 0) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' });
    }
  });
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
    startCommands: environment.start_commands,
    egressMode: environment.egress_mode,
    egressAllowlist: environment.egress_allowlist,
    egressRequiredHosts: environment.egress_required_hosts ?? [],
    isDraft: environment.is_draft,
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
    .where(
      and(buildEnvironmentOwnershipCondition(owner), eq(cloud_agent_environments.is_draft, false))
    )
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
 * The draft a session may see, if the caller asked to allow one: the run must
 * belong to the owner, still be open and allowed to change, and its draft must
 * be the requested environment. Any other case leaves the draft invisible.
 */
async function allowedDraftEnvironmentId(
  tx: EnvironmentTransaction,
  input: {
    owner: EnvironmentOwner;
    environmentId?: string;
    allowDraft?: { setupRunId: string };
  }
): Promise<string | undefined> {
  if (input.allowDraft === undefined || input.environmentId === undefined) return undefined;

  const [run] = await tx
    .select({
      draft: cloud_agent_environment_setup_runs.draft_environment_id,
      status: cloud_agent_environment_setup_runs.status,
    })
    .from(cloud_agent_environment_setup_runs)
    .where(
      and(
        eq(cloud_agent_environment_setup_runs.id, input.allowDraft.setupRunId),
        setupRunOwnershipCondition(input.owner)
      )
    );

  if (
    run?.draft === input.environmentId &&
    isOpenSetupRunStatus(run.status) &&
    run.status !== 'failed'
  ) {
    return input.environmentId;
  }
  return undefined;
}

/**
 * Load the environment of a session's launch repository: the primitives the
 * session merges, the authorized reference that travels beside them, and the saved
 * allocation. A V1 environment matches by its identity columns and a V2
 * environment by containment of the repository.
 *
 * With `environmentId`, only that environment is considered. Without one, several
 * matches are a `conflict` and no environment is chosen. Drafts stay invisible
 * unless `allowDraft` names the setup run that owns the requested draft.
 */
export async function loadEnvironmentForSession(
  db: WorkerDb,
  input: {
    owner: EnvironmentOwner;
    repository: EnvironmentRepositoryIdentity;
    environmentId?: string;
    allowDraft?: { setupRunId: string };
  }
): Promise<EnvironmentSessionResolution> {
  return db.transaction(
    async tx => {
      const draftEnvironmentId = await allowedDraftEnvironmentId(tx, input);
      const selection = await selectEnvironmentForSession(tx, {
        owner: input.owner,
        repository: input.repository,
        ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
        ...(draftEnvironmentId === undefined ? {} : { draftEnvironmentId }),
      });
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
            startCommands: environment.start_commands,
            ...(repositories ? { repositories: repositories.map(referenceRepositoryOf) } : {}),
          },
          reference: referenceOf(environment),
          sandboxAllocation: environment.sandbox_allocation,
          egressMode: environment.egress_mode,
          egressAllowlist: environment.egress_allowlist,
          egressRequiredHosts: environment.egress_required_hosts ?? [],
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

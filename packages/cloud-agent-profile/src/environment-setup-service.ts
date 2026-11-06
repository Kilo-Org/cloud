import type { WorkerDb } from '@kilocode/db';
import {
  cloud_agent_environment_setup_runs,
  cloud_agent_environment_vars,
  cloud_agent_environments,
  type CloudAgentEnvironment,
  type CloudAgentEnvironmentSetupRun,
  type EnvironmentSetupCheck,
  type EnvironmentSetupNetworkRequest,
  type EnvironmentSetupPreviousConfiguration,
  type EnvironmentSetupRunStatus,
  type EnvironmentSetupSecretRequest,
  type EnvironmentSetupTargetSettings,
  type EnvironmentSetupVerification,
} from '@kilocode/db/schema';
import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { TRPCError } from '@trpc/server';
import { egressDomainSchema, type EgressMode } from '@kilocode/worker-utils/egress-allowlist';
import { randomUUID } from 'node:crypto';
import {
  ENVIRONMENT_SETUP_LIMITS,
  OPEN_SETUP_RUN_STATUSES,
  AGENT_WRITABLE_SETUP_RUN_STATUSES,
  effectiveEgressAllowlist,
  evaluateCompletionGate,
  hasDuplicateCheckNames,
  isHighPrivilegeSecretKey,
  isOpenSetupRunStatus,
  isResumableSetupRunStatus,
  pendingRequestCount,
} from './environment-setup-contracts';
import type { ENVIRONMENT_SETUP_STATUS_REASONS } from './environment-setup-contracts';
import {
  assertValidEnvironmentKey,
  repositoryLeaf,
  validateEnvironmentVarCount,
  type EnvironmentOwner,
  type EnvironmentRepositoryEntry,
  type EnvironmentSecretChange,
} from './environment-contracts';
import {
  assertEffectiveAllowlistWithinLimit,
  createEnvironment,
  lockActiveOrganization,
  updateEnvironment,
  type EnvironmentTransaction,
} from './environment-service';
import {
  buildEnvironmentOwnershipCondition,
  setupRunOwnershipCondition,
} from './environment-lookup';
import { environmentRepositoriesSchema } from './environment-repository-entry';
import { readRepositories } from './environment-repositories';

export type EnvironmentSetupStatusReason = (typeof ENVIRONMENT_SETUP_STATUS_REASONS)[number];

const VERIFICATION_LOCK_MS = 30 * 60 * 1000;
const ABANDONED_RUN_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_DRAFT_MS = 14 * 24 * 60 * 60 * 1000;
const PREVIOUS_CONFIGURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_STATUS_DETAIL_LENGTH = 2000;

const runs = cloud_agent_environment_setup_runs;
const environments = cloud_agent_environments;
const variables = cloud_agent_environment_vars;

const RESOLVABLE_STATUSES: readonly EnvironmentSetupRunStatus[] = OPEN_SETUP_RUN_STATUSES.filter(
  status => status !== 'failed' && status !== 'publish_conflict'
);

function conflict(message: string): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message });
}

function badRequest(message: string): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message });
}

function corruptEnvironment(): TRPCError {
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Environment repository identity is incomplete',
  });
}

function assertStatus(
  run: Pick<CloudAgentEnvironmentSetupRun, 'status'>,
  allowed: readonly EnvironmentSetupRunStatus[]
): void {
  if (!allowed.includes(run.status)) {
    throw conflict(`Setup run is ${run.status}`);
  }
}

function assertAgentWritable(run: Pick<CloudAgentEnvironmentSetupRun, 'status'>): void {
  assertStatus(run, AGENT_WRITABLE_SETUP_RUN_STATUSES);
}

/**
 * PostgreSQL SQLSTATE 23505, with the cause chain drizzle and postgres-js wrap
 * it in. Only the five-character SQLSTATE shape counts, so unrelated `code`
 * fields such as `ENOTFOUND` are ignored.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth++) {
    if (current === null || typeof current !== 'object') return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) {
      return candidate.code === '23505';
    }
    current = candidate.cause;
  }
  return false;
}

async function lockOwnerOrganization(
  tx: EnvironmentTransaction,
  owner: EnvironmentOwner
): Promise<void> {
  if (owner.type === 'organization') {
    await lockActiveOrganization(tx, owner.id);
  }
}

async function lockSetupRun(
  tx: EnvironmentTransaction,
  runId: string,
  owner: EnvironmentOwner
): Promise<CloudAgentEnvironmentSetupRun> {
  const [run] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), setupRunOwnershipCondition(owner)))
    .for('update');
  if (!run) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Setup run not found' });
  }
  if (isOpenSetupRunStatus(run.status) && run.draft_environment_id === null) {
    throw conflict('Setup run is cancelled');
  }
  return run;
}

async function markRunFailed(
  tx: EnvironmentTransaction,
  runId: string,
  reason: EnvironmentSetupStatusReason,
  detail: string | null
): Promise<void> {
  await tx
    .update(runs)
    .set({
      status: 'failed',
      status_reason: reason,
      status_detail: detail === null ? null : detail.slice(0, MAX_STATUS_DETAIL_LENGTH),
    })
    .where(eq(runs.id, runId));
}

async function readDraftEnvironment(
  tx: EnvironmentTransaction,
  draftEnvironmentId: string | null,
  owner: EnvironmentOwner
): Promise<CloudAgentEnvironment | null> {
  if (draftEnvironmentId === null) return null;
  const [draft] = await tx
    .select()
    .from(environments)
    .where(
      and(
        eq(environments.id, draftEnvironmentId),
        eq(environments.is_draft, true),
        buildEnvironmentOwnershipCondition(owner)
      )
    )
    .for('update');
  return draft ?? null;
}

async function lockTargetEnvironment(
  tx: EnvironmentTransaction,
  environmentId: string,
  owner: EnvironmentOwner
): Promise<CloudAgentEnvironment> {
  const [target] = await tx
    .select()
    .from(environments)
    .where(
      and(
        eq(environments.id, environmentId),
        eq(environments.is_draft, false),
        buildEnvironmentOwnershipCondition(owner)
      )
    )
    .for('update');
  if (!target) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' });
  }
  return target;
}

type StoredVariable = { key: string; value: string; isSecret: boolean };

async function readStoredVariables(
  tx: EnvironmentTransaction,
  environmentId: string
): Promise<StoredVariable[]> {
  return tx
    .select({
      key: variables.key,
      value: variables.value,
      isSecret: variables.is_secret,
    })
    .from(variables)
    .where(eq(variables.environment_id, environmentId))
    .orderBy(variables.key);
}

function settingsOf(environment: CloudAgentEnvironment): EnvironmentSetupTargetSettings {
  return {
    sandboxAllocation: environment.sandbox_allocation,
    egressMode: environment.egress_mode,
    egressAllowlist: environment.egress_allowlist,
    egressRequiredHosts: environment.egress_required_hosts,
  };
}

function sameHosts(left: readonly string[] | null, right: readonly string[] | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.length === right.length &&
      left.every((host, index) => host === right[index]))
  );
}

function sameSettings(
  left: EnvironmentSetupTargetSettings,
  right: EnvironmentSetupTargetSettings
): boolean {
  return (
    left.sandboxAllocation === right.sandboxAllocation &&
    left.egressMode === right.egressMode &&
    sameHosts(left.egressAllowlist, right.egressAllowlist) &&
    sameHosts(left.egressRequiredHosts, right.egressRequiredHosts)
  );
}

function singleRepositoryEntry(environment: CloudAgentEnvironment): EnvironmentRepositoryEntry {
  const repoFullName = environment.repo_full_name;
  if (repoFullName === null) throw corruptEnvironment();

  switch (environment.platform) {
    case 'github':
      return { platform: 'github', repoFullName };
    case 'gitlab': {
      const cloneUrl = environment.gitlab_clone_url;
      if (cloneUrl === null) throw corruptEnvironment();
      return { platform: 'gitlab', repoFullName, gitlabCloneUrl: cloneUrl };
    }
    case 'bitbucket': {
      const workspaceUuid = environment.bitbucket_workspace_uuid;
      const repositoryUuid = environment.bitbucket_repository_uuid;
      if (workspaceUuid === null || repositoryUuid === null) throw corruptEnvironment();
      return {
        platform: 'bitbucket',
        repoFullName,
        bitbucketWorkspaceUuid: workspaceUuid,
        bitbucketRepositoryUuid: repositoryUuid,
      };
    }
    default:
      throw corruptEnvironment();
  }
}

function repositoriesOf(environment: CloudAgentEnvironment): EnvironmentRepositoryEntry[] {
  return readRepositories(environment) ?? [singleRepositoryEntry(environment)];
}

function parsePreviousRepositories(value: unknown): EnvironmentRepositoryEntry[] {
  const parsed = environmentRepositoriesSchema.safeParse(value);
  if (!parsed.success) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Previous environment repositories are invalid',
    });
  }
  return parsed.data;
}

function normalizeHosts(hosts: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const host of hosts) {
    const lowered = host.toLowerCase();
    if (!normalized.includes(lowered)) normalized.push(lowered);
  }
  return normalized;
}

function approvedHosts(run: CloudAgentEnvironmentSetupRun): string[] {
  return normalizeHosts(
    run.network_requests
      .filter(request => request.state === 'approved')
      .map(request => request.host)
  );
}

function resolvedStatus(run: CloudAgentEnvironmentSetupRun): EnvironmentSetupRunStatus {
  return pendingRequestCount(run) > 0 ? 'needs_input' : 'running';
}

async function replaceVariables(
  tx: EnvironmentTransaction,
  environmentId: string,
  vars: readonly StoredVariable[]
): Promise<void> {
  await tx.delete(variables).where(eq(variables.environment_id, environmentId));
  if (vars.length === 0) return;
  await tx.insert(variables).values(
    vars.map(variable => ({
      environment_id: environmentId,
      key: variable.key,
      value: variable.value,
      is_secret: variable.isSecret,
    }))
  );
}

type EnvironmentConfiguration = {
  commands: string[];
  repositories: EnvironmentRepositoryEntry[];
  sandboxAllocation: string | null;
  egressMode: 'unrestricted' | 'allowlist' | null;
  egressAllowlist: string[] | null;
  egressRequiredHosts: string[] | null;
};

async function writeEnvironmentConfiguration(
  tx: EnvironmentTransaction,
  environmentId: string,
  configuration: EnvironmentConfiguration
): Promise<number> {
  const [updated] = await tx
    .update(environments)
    .set({
      commands: configuration.commands,
      repositories: configuration.repositories,
      platform: null,
      repo_full_name: null,
      gitlab_clone_url: null,
      bitbucket_workspace_uuid: null,
      bitbucket_repository_uuid: null,
      sandbox_allocation: configuration.sandboxAllocation,
      egress_mode: configuration.egressMode,
      egress_allowlist: configuration.egressAllowlist,
      egress_required_hosts: configuration.egressRequiredHosts,
      configuration_revision: sql`${environments.configuration_revision} + 1`,
    })
    .where(eq(environments.id, environmentId))
    .returning({ configurationRevision: environments.configuration_revision });
  if (!updated) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Environment not found' });
  }
  return updated.configurationRevision;
}

function previousConfigurationOf(
  target: CloudAgentEnvironment,
  storedVars: readonly StoredVariable[]
): EnvironmentSetupPreviousConfiguration {
  return {
    environmentId: target.id,
    revision: target.configuration_revision,
    commands: target.commands,
    repositories: repositoriesOf(target),
    sandboxAllocation: target.sandbox_allocation,
    egressMode: target.egress_mode,
    egressAllowlist: target.egress_allowlist,
    egressRequiredHosts: target.egress_required_hosts,
    vars: storedVars.map(variable => ({
      key: variable.key,
      value: variable.value,
      isSecret: variable.isSecret,
    })),
  };
}

export type CreateSetupRunWithDraftInput = {
  owner: EnvironmentOwner;
  createdByUserId: string;
  repositories: EnvironmentRepositoryEntry[];
  name?: string;
  targetEnvironmentId?: string;
  egressMode?: EgressMode;
  initialSecrets?: Record<string, string>;
  requirements: string;
  model: string;
  variant?: string | null;
  launchRepoFullName: string;
  sandboxOptions: string[];
  initialSandboxAllocation?: string;
};

export type CreateSetupRunWithDraftResult = {
  runId: string;
  draftEnvironmentId: string;
};

/**
 * Create the draft environment and its setup run in one transaction. A target
 * environment is locked before it is read, and the organization row is locked
 * first so organization soft-delete serializes with every mutation.
 */
export async function createSetupRunWithDraft(
  tx: EnvironmentTransaction,
  publicKeyBase64: string,
  input: CreateSetupRunWithDraftInput
): Promise<CreateSetupRunWithDraftResult> {
  const requirements = input.requirements.trim();
  if (
    requirements.length === 0 ||
    requirements.length > ENVIRONMENT_SETUP_LIMITS.MAX_REQUIREMENTS_LENGTH
  ) {
    throw badRequest(
      `Requirements must be 1-${ENVIRONMENT_SETUP_LIMITS.MAX_REQUIREMENTS_LENGTH} characters`
    );
  }
  if (input.repositories.length === 0 || input.repositories[0].platform !== 'github') {
    throw badRequest('The first repository must be a GitHub repository.');
  }

  await lockOwnerOrganization(tx, input.owner);

  const target =
    input.targetEnvironmentId === undefined
      ? null
      : await lockTargetEnvironment(tx, input.targetEnvironmentId, input.owner);

  const targetVars = target === null ? [] : await readStoredVariables(tx, target.id);
  const plainVars: Record<string, string> = {};
  for (const variable of targetVars) {
    if (!variable.isSecret) plainVars[variable.key] = variable.value;
  }

  const initialSecrets = input.initialSecrets ?? {};
  const egressMode = input.egressMode ?? target?.egress_mode ?? 'unrestricted';
  const { id: draftEnvironmentId } = await createEnvironment(tx, publicKeyBase64, {
    owner: input.owner,
    createdByUserId: input.createdByUserId,
    name: input.name ?? target?.name ?? repositoryLeaf(input.repositories[0].repoFullName),
    repositories: input.repositories,
    commands: target?.commands ?? [],
    plainVars,
    secrets: initialSecrets,
    sandboxAllocation: input.initialSandboxAllocation ?? target?.sandbox_allocation ?? null,
    egressMode,
    ...(egressMode === 'allowlist'
      ? {
          egressAllowlist:
            target?.egress_mode === 'allowlist' ? (target.egress_allowlist ?? []) : [],
        }
      : {}),
  });

  await tx
    .update(environments)
    .set({
      is_draft: true,
      draft_for_environment_id: target?.id ?? null,
      egress_required_hosts: target?.egress_required_hosts ?? null,
    })
    .where(eq(environments.id, draftEnvironmentId));

  const initialSecretKeys = new Set(Object.keys(initialSecrets));
  const copiedSecrets = targetVars.filter(
    variable => variable.isSecret && !initialSecretKeys.has(variable.key)
  );
  if (copiedSecrets.length > 0) {
    await tx.insert(variables).values(
      copiedSecrets.map(variable => ({
        environment_id: draftEnvironmentId,
        key: variable.key,
        value: variable.value,
        is_secret: true,
      }))
    );
  }
  validateEnvironmentVarCount(
    Object.keys(plainVars).length + initialSecretKeys.size + copiedSecrets.length
  );

  try {
    const [run] = await tx
      .insert(runs)
      .values({
        owned_by_user_id: input.owner.type === 'user' ? input.owner.id : null,
        owned_by_organization_id: input.owner.type === 'organization' ? input.owner.id : null,
        created_by_user_id: input.createdByUserId,
        draft_environment_id: draftEnvironmentId,
        target_environment_id: target?.id ?? null,
        target_revision_at_fork: target?.configuration_revision ?? null,
        target_settings_at_fork: target === null ? null : settingsOf(target),
        requirements,
        model: input.model,
        variant: input.variant ?? null,
        launch_repo_full_name: input.launchRepoFullName,
        status: 'starting',
        sandbox_options: input.sandboxOptions,
        verification_limit: ENVIRONMENT_SETUP_LIMITS.DEFAULT_VERIFICATION_LIMIT,
      })
      .returning({ id: runs.id });
    if (!run) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Setup run creation failed',
      });
    }
    return { runId: run.id, draftEnvironmentId };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('This environment already has a setup run in progress');
    }
    throw error;
  }
}

export type AttachSetupSessionInput = {
  runId: string;
  owner: EnvironmentOwner;
  cloudAgentSessionId: string;
  kiloSessionId: string | null;
};

export async function attachSetupSession(
  tx: EnvironmentTransaction,
  input: AttachSetupSessionInput
): Promise<void> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  assertStatus(run, ['starting']);

  try {
    await tx
      .update(runs)
      .set({
        status: 'running',
        cloud_agent_session_id: input.cloudAgentSessionId,
        kilo_session_id: input.kiloSessionId,
      })
      .where(eq(runs.id, run.id));
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('This session is already attached to a setup run');
    }
    throw error;
  }
}

export type FailSetupRunInput = {
  runId: string;
  owner: EnvironmentOwner;
  reason: EnvironmentSetupStatusReason;
  detail?: string | null;
};

/**
 * Ends a run whose setup session never started. Nothing can resume it, so it is
 * cancelled and no longer blocks a new run for the same target.
 */
export async function cancelUnstartedSetupRun(
  tx: EnvironmentTransaction,
  input: { runId: string; owner: EnvironmentOwner; detail: string }
): Promise<void> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  assertStatus(run, ['starting']);
  await tx
    .update(runs)
    .set({
      status: 'cancelled',
      status_reason: 'session_start_failed',
      status_detail: input.detail.slice(0, MAX_STATUS_DETAIL_LENGTH),
      completed_at: new Date().toISOString(),
    })
    .where(eq(runs.id, run.id));
}

export async function failSetupRunByAgent(
  tx: EnvironmentTransaction,
  input: FailSetupRunInput
): Promise<void> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  assertAgentWritable(run);
  await markRunFailed(tx, run.id, input.reason, input.detail ?? null);
}

export async function getSetupRun(
  db: WorkerDb,
  runId: string,
  owner: EnvironmentOwner
): Promise<CloudAgentEnvironmentSetupRun> {
  const [run] = await db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), setupRunOwnershipCondition(owner)));
  if (!run) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Setup run not found' });
  }
  return run;
}

export async function getSetupRunBySession(
  db: WorkerDb,
  cloudAgentSessionId: string,
  owner: EnvironmentOwner
): Promise<CloudAgentEnvironmentSetupRun | null> {
  const [run] = await db
    .select()
    .from(runs)
    .where(
      and(eq(runs.cloud_agent_session_id, cloudAgentSessionId), setupRunOwnershipCondition(owner))
    );
  return run ?? null;
}

export async function listSetupRunsForEnvironment(
  db: WorkerDb,
  environmentId: string,
  owner: EnvironmentOwner
): Promise<CloudAgentEnvironmentSetupRun[]> {
  return db
    .select()
    .from(runs)
    .where(
      and(
        setupRunOwnershipCondition(owner),
        or(
          eq(runs.target_environment_id, environmentId),
          eq(runs.draft_environment_id, environmentId),
          eq(runs.published_environment_id, environmentId)
        )
      )
    )
    .orderBy(desc(runs.created_at))
    .limit(20);
}

export type UpdateDraftByAgentInput = {
  runId: string;
  owner: EnvironmentOwner;
  expectedRevision: number;
  script?: string;
  plainVars?: Record<string, string>;
  secrets?: EnvironmentSecretChange[];
  sandboxAllocation?: string | null;
  requiredHosts?: string[];
};

export async function updateDraftByAgent(
  tx: EnvironmentTransaction,
  publicKeyBase64: string,
  input: UpdateDraftByAgentInput
): Promise<{ configurationRevision: number }> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  assertAgentWritable(run);

  const draft = await readDraftEnvironment(tx, run.draft_environment_id, input.owner);
  if (!draft) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Draft environment not found' });
  }

  if (draft.configuration_revision !== input.expectedRevision) {
    throw conflict(
      `The draft changed (revision ${draft.configuration_revision}). Call get_environment_draft and retry.`
    );
  }

  if (
    input.sandboxAllocation !== undefined &&
    input.sandboxAllocation !== null &&
    !run.sandbox_options.includes(input.sandboxAllocation)
  ) {
    throw badRequest(
      `Sandbox allocation ${input.sandboxAllocation} is not offered. Offered: ${run.sandbox_options.join(', ')}`
    );
  }

  if (input.requiredHosts !== undefined && draft.egress_mode === 'allowlist') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'The network policy is restricted. Use request_network_hosts.',
    });
  }

  const pendingSecretKeys = new Set(
    run.secret_requests.filter(request => request.state === 'pending').map(request => request.key)
  );
  const generatedKeys = new Set(run.generated_secret_keys);
  const storedSecretKeys = new Set(
    input.secrets?.length
      ? (await readStoredVariables(tx, draft.id))
          .filter(variable => variable.isSecret)
          .map(variable => variable.key)
      : []
  );
  for (const change of input.secrets ?? []) {
    if (pendingSecretKeys.has(change.key)) {
      throw badRequest(`The user was asked for ${change.key}. Wait for the follow-up message.`);
    }
    if (
      !generatedKeys.has(change.key) &&
      ('delete' in change || storedSecretKeys.has(change.key))
    ) {
      throw badRequest(`The agent can only change secrets it generated: ${change.key}.`);
    }
  }

  const { configurationRevision } = await updateEnvironment(tx, publicKeyBase64, {
    owner: input.owner,
    environmentId: draft.id,
    ...(input.script === undefined ? {} : { commands: input.script.trim() ? [input.script] : [] }),
    ...(input.plainVars === undefined ? {} : { plainVars: input.plainVars }),
    ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
    ...(input.sandboxAllocation === undefined
      ? {}
      : { sandboxAllocation: input.sandboxAllocation }),
    ...(input.requiredHosts === undefined ? {} : { requiredHosts: input.requiredHosts }),
  });

  const revisionChanged = configurationRevision !== draft.configuration_revision;
  for (const change of input.secrets ?? []) {
    if ('delete' in change) {
      generatedKeys.delete(change.key);
    } else {
      generatedKeys.add(change.key);
    }
  }
  const nextGeneratedKeys = [...generatedKeys];
  const generatedKeysChanged =
    JSON.stringify(nextGeneratedKeys) !== JSON.stringify(run.generated_secret_keys);

  const nextStatus =
    revisionChanged && run.status === 'verifying' ? resolvedStatus(run) : run.status;
  if (revisionChanged || generatedKeysChanged || nextStatus !== run.status) {
    await tx
      .update(runs)
      .set({
        ...(revisionChanged ? { pending_verification: null } : {}),
        ...(generatedKeysChanged ? { generated_secret_keys: nextGeneratedKeys } : {}),
        ...(nextStatus !== run.status ? { status: nextStatus } : {}),
      })
      .where(eq(runs.id, run.id));
  }

  return { configurationRevision };
}

export type SetupSecretRequestInput = {
  key: string;
  reason: string;
  references: { repoFullName: string; path: string; line: number; verified?: boolean }[];
};

export type AddSecretRequestsInput = {
  runId: string;
  owner: EnvironmentOwner;
  requests: SetupSecretRequestInput[];
};

export async function addSecretRequests(
  tx: EnvironmentTransaction,
  input: AddSecretRequestsInput
): Promise<{ requested: string[] }> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  assertStatus(run, ['running', 'verifying']);

  if (input.requests.length > ENVIRONMENT_SETUP_LIMITS.MAX_SECRET_KEYS_PER_REQUEST) {
    throw badRequest(
      `At most ${ENVIRONMENT_SETUP_LIMITS.MAX_SECRET_KEYS_PER_REQUEST} secret keys can be requested at once`
    );
  }
  if (
    run.secret_requests.length + input.requests.length >
    ENVIRONMENT_SETUP_LIMITS.MAX_SECRET_REQUESTS_PER_RUN
  ) {
    throw badRequest(
      `At most ${ENVIRONMENT_SETUP_LIMITS.MAX_SECRET_REQUESTS_PER_RUN} secret requests are allowed per setup run`
    );
  }

  const draft = await readDraftEnvironment(tx, run.draft_environment_id, input.owner);
  if (!draft) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Draft environment not found' });
  }
  const storedKeys = new Set(
    (await readStoredVariables(tx, draft.id)).map(variable => variable.key)
  );
  const pendingKeys = new Set(
    run.secret_requests.filter(request => request.state === 'pending').map(request => request.key)
  );

  for (const request of input.requests) {
    assertValidEnvironmentKey(request.key);
    if (storedKeys.has(request.key)) {
      throw badRequest(`${request.key} already has a value. Ask the user in chat to replace it.`);
    }
    if (pendingKeys.has(request.key)) {
      throw badRequest(`${request.key} was already requested. Wait for the user.`);
    }
    pendingKeys.add(request.key);
  }

  const requestedAt = new Date().toISOString();
  const added: EnvironmentSetupSecretRequest[] = input.requests.map(request => ({
    key: request.key,
    reason: request.reason,
    references: request.references,
    highPrivilege: isHighPrivilegeSecretKey(request.key),
    state: 'pending',
    requestedAt,
  }));

  await tx
    .update(runs)
    .set({
      secret_requests: [...run.secret_requests, ...added],
      status: 'needs_input',
    })
    .where(eq(runs.id, run.id));

  return { requested: added.map(request => request.key) };
}

export type ResolveSecretRequestsInput = {
  runId: string;
  owner: EnvironmentOwner;
  skipped: string[];
};

export type ResolveSecretRequestsResult = {
  provided: string[];
  skipped: string[];
  stillPending: string[];
  resumed: boolean;
};

export async function resolveSecretRequests(
  tx: EnvironmentTransaction,
  input: ResolveSecretRequestsInput
): Promise<ResolveSecretRequestsResult> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  assertStatus(run, RESOLVABLE_STATUSES);

  const draft = await readDraftEnvironment(tx, run.draft_environment_id, input.owner);
  if (!draft) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Draft environment not found' });
  }
  const keysWithValues = new Set(
    (await readStoredVariables(tx, draft.id)).map(variable => variable.key)
  );
  const skippedKeys = new Set(input.skipped);

  const provided: string[] = [];
  const skipped: string[] = [];
  const secretRequests: EnvironmentSetupSecretRequest[] = run.secret_requests.map(request => {
    if (request.state !== 'pending') return request;
    if (keysWithValues.has(request.key)) {
      provided.push(request.key);
      return { ...request, state: 'provided' };
    }
    if (skippedKeys.has(request.key)) {
      skipped.push(request.key);
      return { ...request, state: 'skipped' };
    }
    return request;
  });

  const stillPending = secretRequests
    .filter(request => request.state === 'pending')
    .map(request => request.key);
  const resumedStatus: EnvironmentSetupRunStatus | null =
    run.status === 'needs_input' &&
    pendingRequestCount({
      secret_requests: secretRequests,
      network_requests: run.network_requests,
    }) === 0
      ? run.pending_verification === null
        ? 'running'
        : 'verifying'
      : null;
  const resumed = resumedStatus !== null;

  await tx
    .update(runs)
    .set({
      secret_requests: secretRequests,
      ...(resumedStatus === null ? {} : { status: resumedStatus }),
    })
    .where(eq(runs.id, run.id));

  return { provided, skipped, stillPending, resumed };
}

export type SetupNetworkRequestInput = {
  host: string;
  reason: string;
  evidence: EnvironmentSetupNetworkRequest['evidence'];
};

export type AddNetworkRequestsInput = {
  runId: string;
  owner: EnvironmentOwner;
  requests: SetupNetworkRequestInput[];
};

export async function addNetworkRequests(
  tx: EnvironmentTransaction,
  input: AddNetworkRequestsInput
): Promise<{ requested: string[] }> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  assertStatus(run, ['running', 'verifying']);

  const draft = await readDraftEnvironment(tx, run.draft_environment_id, input.owner);
  if (!draft) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Draft environment not found' });
  }
  if (draft.egress_mode !== 'allowlist') {
    throw badRequest(
      'Network policy is not restricted. Use update_environment_draft requiredHosts.'
    );
  }
  if (input.requests.length > ENVIRONMENT_SETUP_LIMITS.MAX_NETWORK_HOSTS_PER_REQUEST) {
    throw badRequest(
      `At most ${ENVIRONMENT_SETUP_LIMITS.MAX_NETWORK_HOSTS_PER_REQUEST} hosts can be requested at once`
    );
  }
  if (
    run.network_requests.length + input.requests.length >
    ENVIRONMENT_SETUP_LIMITS.MAX_NETWORK_REQUESTS_PER_RUN
  ) {
    throw badRequest(
      `At most ${ENVIRONMENT_SETUP_LIMITS.MAX_NETWORK_REQUESTS_PER_RUN} network requests are allowed per setup run`
    );
  }

  const knownHosts = new Set(draft.egress_required_hosts ?? []);
  for (const request of run.network_requests) {
    if (request.state === 'pending') knownHosts.add(request.host);
  }

  const requestedAt = new Date().toISOString();
  const added: EnvironmentSetupNetworkRequest[] = [];
  for (const request of input.requests) {
    const parsedHost = egressDomainSchema.safeParse(request.host);
    if (!parsedHost.success) {
      throw badRequest(`Invalid network host: ${request.host}`);
    }
    if (knownHosts.has(parsedHost.data)) continue;
    knownHosts.add(parsedHost.data);
    added.push({
      host: parsedHost.data,
      reason: request.reason,
      evidence: request.evidence,
      state: 'pending',
      requestedAt,
    });
  }

  if (added.length === 0) return { requested: [] };

  await tx
    .update(runs)
    .set({
      network_requests: [...run.network_requests, ...added],
      status: 'needs_input',
    })
    .where(eq(runs.id, run.id));

  return { requested: added.map(request => request.host) };
}

export type ResolveNetworkRequestsInput = {
  runId: string;
  owner: EnvironmentOwner;
  approved: string[];
  declined: string[];
};

export async function resolveNetworkRequests(
  tx: EnvironmentTransaction,
  publicKeyBase64: string,
  input: ResolveNetworkRequestsInput
): Promise<{ resumed: boolean }> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  assertStatus(run, RESOLVABLE_STATUSES);

  const draft = await readDraftEnvironment(tx, run.draft_environment_id, input.owner);
  if (!draft) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Draft environment not found' });
  }

  const approvedHosts = new Set(normalizeHosts(input.approved));
  const declinedHosts = new Set(normalizeHosts(input.declined));
  const resolvedHosts: string[] = [];
  const networkRequests: EnvironmentSetupNetworkRequest[] = run.network_requests.map(request => {
    if (request.state !== 'pending') return request;
    if (approvedHosts.has(request.host)) {
      resolvedHosts.push(request.host);
      return { ...request, state: 'approved' };
    }
    if (declinedHosts.has(request.host)) {
      return { ...request, state: 'declined' };
    }
    return request;
  });

  let revisionChanged = false;
  if (resolvedHosts.length > 0) {
    const requiredHosts = normalizeHosts([
      ...(draft.egress_required_hosts ?? []),
      ...resolvedHosts,
    ]);
    const { configurationRevision } = await updateEnvironment(tx, publicKeyBase64, {
      owner: input.owner,
      environmentId: draft.id,
      requiredHosts,
    });
    revisionChanged = configurationRevision !== draft.configuration_revision;
  }

  const resumedStatus: EnvironmentSetupRunStatus | null =
    run.status === 'needs_input' &&
    pendingRequestCount({
      secret_requests: run.secret_requests,
      network_requests: networkRequests,
    }) === 0
      ? run.pending_verification === null || revisionChanged
        ? 'running'
        : 'verifying'
      : null;
  const resumed = resumedStatus !== null;

  await tx
    .update(runs)
    .set({
      network_requests: networkRequests,
      ...(revisionChanged ? { pending_verification: null } : {}),
      ...(resumedStatus === null ? {} : { status: resumedStatus }),
    })
    .where(eq(runs.id, run.id));

  return { resumed };
}

export type ReserveVerificationInput = {
  runId: string;
  owner: EnvironmentOwner;
  checks: EnvironmentSetupCheck[];
};

export type ReserveVerificationResult =
  | { status: 'reserved'; operationKey: string; configurationRevision: number }
  | { status: 'limit_reached' };

export async function reserveVerification(
  tx: EnvironmentTransaction,
  input: ReserveVerificationInput
): Promise<ReserveVerificationResult> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  assertAgentWritable(run);

  if (run.network_requests.some(request => request.state === 'pending')) {
    throw conflict('Wait for the user to review the discovered network hosts before verification.');
  }

  if (input.checks.length > ENVIRONMENT_SETUP_LIMITS.MAX_CHECKS) {
    throw badRequest(`At most ${ENVIRONMENT_SETUP_LIMITS.MAX_CHECKS} checks are allowed`);
  }

  if (hasDuplicateCheckNames(input.checks)) {
    throw badRequest('Verification check names must be unique.');
  }

  const pending = run.pending_verification;
  if (pending !== null && Date.now() - Date.parse(pending.startedAt) < VERIFICATION_LOCK_MS) {
    throw conflict('A verification is already running. Wait for its result message.');
  }

  if (run.verification_count >= run.verification_limit) {
    await markRunFailed(tx, run.id, 'verification_limit_reached', null);
    return { status: 'limit_reached' };
  }

  const draft = await readDraftEnvironment(tx, run.draft_environment_id, input.owner);
  if (!draft) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Draft environment not found' });
  }

  const operationKey = randomUUID();
  const startedAt = new Date().toISOString();
  await tx
    .update(runs)
    .set({
      pending_verification: {
        operationKey,
        childSessionId: null,
        childKiloSessionId: null,
        configurationRevision: draft.configuration_revision,
        checks: input.checks,
        startedAt,
        sandboxAllocation: draft.sandbox_allocation,
        egressAllowlist: effectiveEgressAllowlist(
          draft.egress_mode,
          draft.egress_allowlist,
          draft.egress_required_hosts
        ),
      },
      verification_count: sql`${runs.verification_count} + 1`,
      status: run.status === 'needs_input' ? run.status : 'verifying',
    })
    .where(eq(runs.id, run.id));

  return { status: 'reserved', operationKey, configurationRevision: draft.configuration_revision };
}

export type AttachVerificationChildInput = {
  runId: string;
  owner: EnvironmentOwner;
  operationKey: string;
  childSessionId: string;
  childKiloSessionId: string | null;
};

export async function attachVerificationChild(
  tx: EnvironmentTransaction,
  input: AttachVerificationChildInput
): Promise<void> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  if (!isOpenSetupRunStatus(run.status)) {
    throw conflict(`Setup run is ${run.status}`);
  }
  const pending = run.pending_verification;
  if (pending === null || pending.operationKey !== input.operationKey) {
    throw conflict('The verification is no longer pending. Start a new verification.');
  }

  await tx
    .update(runs)
    .set({
      pending_verification: {
        ...pending,
        childSessionId: input.childSessionId,
        childKiloSessionId: input.childKiloSessionId,
      },
    })
    .where(eq(runs.id, run.id));
}

export type ReleaseVerificationInput = {
  runId: string;
  owner: EnvironmentOwner;
  operationKey: string;
};

export async function releaseVerification(
  tx: EnvironmentTransaction,
  input: ReleaseVerificationInput
): Promise<void> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  if (!isOpenSetupRunStatus(run.status)) return;
  if (run.pending_verification?.operationKey !== input.operationKey) return;

  await tx
    .update(runs)
    .set({
      pending_verification: null,
      verification_count: sql`greatest(${runs.verification_count} - 1, 0)`,
      status: resolvedStatus(run),
    })
    .where(eq(runs.id, run.id));
}

export type RecordVerificationInput = {
  runId: string;
  owner: EnvironmentOwner;
  childSessionId: string;
  verification: EnvironmentSetupVerification;
};

export async function recordVerification(
  tx: EnvironmentTransaction,
  input: RecordVerificationInput
): Promise<void> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  assertAgentWritable(run);

  if (
    run.pending_verification?.childSessionId !== input.childSessionId &&
    run.last_verification?.childSessionId !== input.childSessionId
  ) {
    throw badRequest(
      'Unknown verification session. A draft change may have superseded it; start a new verification.'
    );
  }

  if (
    run.pending_verification !== null &&
    run.pending_verification.childSessionId !== input.childSessionId
  ) {
    throw conflict(
      'A newer verification is pending. Record its results before updating an earlier verification.'
    );
  }

  if (hasDuplicateCheckNames(input.verification.results)) {
    throw badRequest('Verification result names must be unique.');
  }

  const verification: EnvironmentSetupVerification = {
    ...input.verification,
    childSessionId: input.childSessionId,
    sandboxAllocation:
      input.verification.sandboxAllocation ?? run.pending_verification?.sandboxAllocation ?? null,
    egressAllowlist:
      input.verification.egressAllowlist ?? run.pending_verification?.egressAllowlist ?? null,
  };
  await tx
    .update(runs)
    .set({
      last_verification: verification,
      pending_verification: null,
      status: resolvedStatus(run),
    })
    .where(eq(runs.id, run.id));
}

export async function getAgentWritableSetupRun(
  db: WorkerDb,
  input: { runId: string; owner: EnvironmentOwner }
): Promise<CloudAgentEnvironmentSetupRun> {
  const run = await getSetupRun(db, input.runId, input.owner);
  assertAgentWritable(run);
  return run;
}

export type PublishSetupRunMode = 'gate' | 'force';

export type PublishSetupRunInput = {
  runId: string;
  owner: EnvironmentOwner;
  mode: PublishSetupRunMode;
};

export type PublishSetupRunResult =
  | { status: 'published'; environmentId: string; configurationRevision: number }
  | { status: 'publish_conflict' }
  | { status: 'draft_missing' };

const PUBLISH_STATUSES: Record<PublishSetupRunMode, readonly EnvironmentSetupRunStatus[]> = {
  gate: ['running', 'verifying'],
  force: ['publish_conflict', 'failed'],
};

/**
 * The hosts a publish writes onto an existing target. When the target's network
 * policy changed to restricted after the fork, only hosts the user approved may
 * join its allowlist; hosts the agent merely recorded do not.
 */
function publishedRequiredHosts(
  target: CloudAgentEnvironment,
  forkSettings: EnvironmentSetupTargetSettings | null,
  draft: CloudAgentEnvironment,
  run: CloudAgentEnvironmentSetupRun
): string[] | null {
  const becameRestricted =
    target.egress_mode === 'allowlist' && forkSettings?.egressMode !== 'allowlist';
  if (becameRestricted) {
    return normalizeHosts([...(target.egress_required_hosts ?? []), ...approvedHosts(run)]);
  }
  return draft.egress_required_hosts ?? null;
}

async function publishAsNewEnvironment(
  tx: EnvironmentTransaction,
  runId: string,
  draft: CloudAgentEnvironment
): Promise<PublishSetupRunResult> {
  await tx
    .update(environments)
    .set({ is_draft: false, draft_for_environment_id: null })
    .where(eq(environments.id, draft.id));
  await tx
    .update(runs)
    .set({
      status: 'published',
      published_environment_id: draft.id,
      published_revision: draft.configuration_revision,
      previous_configuration: null,
      published_settings: settingsOf(draft),
      completed_at: new Date().toISOString(),
    })
    .where(eq(runs.id, runId));
  return {
    status: 'published',
    environmentId: draft.id,
    configurationRevision: draft.configuration_revision,
  };
}

export async function completeSetupRun(
  tx: EnvironmentTransaction,
  input: { runId: string; owner: EnvironmentOwner; summary: string }
): Promise<PublishSetupRunResult> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  assertAgentWritable(run);
  await tx.update(runs).set({ summary: input.summary }).where(eq(runs.id, run.id));
  return publishSetupRun(tx, { runId: run.id, owner: input.owner, mode: 'gate' });
}

export async function publishSetupRun(
  tx: EnvironmentTransaction,
  input: PublishSetupRunInput
): Promise<PublishSetupRunResult> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  if (run.status === 'cancelled' && run.status_reason === 'draft_deleted') {
    return { status: 'draft_missing' };
  }
  assertStatus(run, PUBLISH_STATUSES[input.mode]);

  const draft = await readDraftEnvironment(tx, run.draft_environment_id, input.owner);
  if (!draft) {
    await tx
      .update(runs)
      .set({
        status: 'cancelled',
        status_reason: 'draft_deleted',
        completed_at: new Date().toISOString(),
      })
      .where(eq(runs.id, run.id));
    return { status: 'draft_missing' };
  }

  if (input.mode !== 'force') {
    const gate = evaluateCompletionGate({
      draftRevision: draft.configuration_revision,
      draftSandboxAllocation: draft.sandbox_allocation,
      draftEgressMode: draft.egress_mode,
      draftEgressAllowlist: draft.egress_allowlist,
      draftEgressRequiredHosts: draft.egress_required_hosts,
      run,
    });
    if (!gate.ok) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: gate.reason });
  }

  const completedAt = new Date().toISOString();
  if (run.target_environment_id === null) {
    return publishAsNewEnvironment(tx, run.id, draft);
  }

  const [target] = await tx
    .select()
    .from(environments)
    .where(
      and(
        eq(environments.id, run.target_environment_id),
        eq(environments.is_draft, false),
        buildEnvironmentOwnershipCondition(input.owner)
      )
    )
    .for('update');

  if (!target) {
    return publishAsNewEnvironment(tx, run.id, draft);
  }

  const targetSettings = settingsOf(target);
  const settingsDrift =
    run.target_settings_at_fork !== null &&
    !sameSettings(run.target_settings_at_fork, targetSettings);
  const revisionDrift = target.configuration_revision !== run.target_revision_at_fork;
  if ((settingsDrift || revisionDrift) && input.mode !== 'force') {
    await tx.update(runs).set({ status: 'publish_conflict' }).where(eq(runs.id, run.id));
    return { status: 'publish_conflict' };
  }

  const targetVars = await readStoredVariables(tx, target.id);
  const previousConfiguration = previousConfigurationOf(target, targetVars);
  const requiredHosts = publishedRequiredHosts(target, run.target_settings_at_fork, draft, run);
  // Preserve a user's policy edit when they force a conflicting publication.
  // Otherwise publish the same policy that the verification tested.
  const fork = run.target_settings_at_fork;
  const policyChanged =
    fork !== null &&
    (fork.egressMode !== target.egress_mode ||
      !sameHosts(fork.egressAllowlist, target.egress_allowlist));
  const egress = settingsOf(policyChanged ? target : draft);
  if (egress.egressMode === 'allowlist') {
    assertEffectiveAllowlistWithinLimit(egress.egressAllowlist ?? [], requiredHosts ?? []);
  }

  await replaceVariables(
    tx,
    target.id,
    (await readStoredVariables(tx, draft.id)).map(variable => ({
      key: variable.key,
      value: variable.value,
      isSecret: variable.isSecret,
    }))
  );
  const configurationRevision = await writeEnvironmentConfiguration(tx, target.id, {
    commands: draft.commands,
    repositories: repositoriesOf(draft),
    sandboxAllocation: draft.sandbox_allocation,
    egressMode: egress.egressMode,
    egressAllowlist: egress.egressAllowlist,
    egressRequiredHosts: requiredHosts,
  });

  await tx
    .update(runs)
    .set({
      status: 'published',
      published_environment_id: target.id,
      published_revision: configurationRevision,
      previous_configuration: previousConfiguration,
      published_settings: {
        sandboxAllocation: draft.sandbox_allocation,
        egressMode: egress.egressMode,
        egressAllowlist: egress.egressAllowlist,
        egressRequiredHosts: requiredHosts,
      },
      completed_at: completedAt,
    })
    .where(eq(runs.id, run.id));

  await tx.delete(environments).where(eq(environments.id, draft.id));

  return { status: 'published', environmentId: target.id, configurationRevision };
}

export type RevertSetupRunInput = {
  runId: string;
  owner: EnvironmentOwner;
  force?: boolean;
};

export async function revertSetupRun(
  tx: EnvironmentTransaction,
  input: RevertSetupRunInput
): Promise<void> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  assertStatus(run, ['published']);

  const environmentId = run.published_environment_id;
  if (environmentId === null) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Published environment not found' });
  }

  if (run.previous_configuration === null && run.target_environment_id === environmentId) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The previous environment configuration expired. This setup run cannot be reverted.',
    });
  }

  const [environment] = await tx
    .select()
    .from(environments)
    .where(and(eq(environments.id, environmentId), buildEnvironmentOwnershipCondition(input.owner)))
    .for('update');
  if (!environment) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Published environment not found' });
  }

  if (!input.force) {
    const revisionChanged = environment.configuration_revision !== run.published_revision;
    const settingsChanged =
      run.published_settings !== null &&
      !sameSettings(settingsOf(environment), run.published_settings);
    if (revisionChanged || settingsChanged) {
      throw conflict(
        'The environment changed after publication. Revert anyway to overwrite those changes.'
      );
    }
  }

  const previous = run.previous_configuration;
  if (previous === null) {
    await tx
      .update(runs)
      .set({
        status: 'reverted',
        previous_configuration: null,
        completed_at: new Date().toISOString(),
      })
      .where(eq(runs.id, run.id));
    await tx.delete(environments).where(eq(environments.id, environment.id));
    return;
  }

  await replaceVariables(
    tx,
    environment.id,
    previous.vars.map(variable => ({
      key: variable.key,
      value: variable.value,
      isSecret: variable.isSecret,
    }))
  );
  await writeEnvironmentConfiguration(tx, environment.id, {
    commands: previous.commands,
    repositories: parsePreviousRepositories(previous.repositories),
    sandboxAllocation: previous.sandboxAllocation,
    egressMode:
      previous.egressMode === 'allowlist'
        ? 'allowlist'
        : previous.egressMode === 'unrestricted'
          ? 'unrestricted'
          : null,
    egressAllowlist: previous.egressAllowlist,
    egressRequiredHosts: previous.egressRequiredHosts,
  });

  await tx
    .update(runs)
    .set({
      status: 'reverted',
      previous_configuration: null,
      completed_at: new Date().toISOString(),
    })
    .where(eq(runs.id, run.id));
}

export type CancelSetupRunInput = {
  runId: string;
  owner: EnvironmentOwner;
};

export async function cancelSetupRun(
  tx: EnvironmentTransaction,
  input: CancelSetupRunInput
): Promise<void> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);
  if (run.status === 'cancelled' && run.status_reason === 'draft_deleted') return;
  assertStatus(run, OPEN_SETUP_RUN_STATUSES);

  await tx
    .update(runs)
    .set({ status: 'cancelled', completed_at: new Date().toISOString() })
    .where(eq(runs.id, run.id));
}

export type ResumeSetupRunInput = {
  runId: string;
  owner: EnvironmentOwner;
  raiseVerificationLimit?: boolean;
};

export async function resumeSetupRun(
  tx: EnvironmentTransaction,
  input: ResumeSetupRunInput
): Promise<{ status: EnvironmentSetupRunStatus }> {
  await lockOwnerOrganization(tx, input.owner);
  const run = await lockSetupRun(tx, input.runId, input.owner);

  const resumable = isResumableSetupRunStatus(run.status) && run.draft_environment_id !== null;
  if (!resumable) {
    throw conflict(`Setup run is ${run.status}`);
  }

  const status = resolvedStatus(run);
  const verificationLimit = input.raiseVerificationLimit
    ? run.verification_limit + ENVIRONMENT_SETUP_LIMITS.DEFAULT_VERIFICATION_LIMIT
    : run.verification_limit;

  await tx
    .update(runs)
    .set({
      status,
      verification_limit: verificationLimit,
      status_reason: null,
      status_detail: null,
    })
    .where(eq(runs.id, run.id));

  return { status };
}

export type LoadSetupRunForSessionInput = {
  runId: string;
  owner: EnvironmentOwner;
};

export async function loadSetupRunForSession(
  db: WorkerDb,
  input: LoadSetupRunForSessionInput
): Promise<{ draftEnvironmentId: string | null; status: EnvironmentSetupRunStatus } | null> {
  const [run] = await db
    .select({
      draftEnvironmentId: runs.draft_environment_id,
      status: runs.status,
    })
    .from(runs)
    .where(and(eq(runs.id, input.runId), setupRunOwnershipCondition(input.owner)))
    .limit(1);
  return run ?? null;
}

export type CleanupSetupRunsResult = {
  abandoned: number;
  draftsDeleted: number;
  previousConfigurationsCleared: number;
};

export async function cleanupSetupRuns(db: WorkerDb, now: Date): Promise<CleanupSetupRunsResult> {
  const abandonedBefore = new Date(now.getTime() - ABANDONED_RUN_MS).toISOString();
  const staleDraftBefore = new Date(now.getTime() - STALE_DRAFT_MS).toISOString();
  const previousBefore = new Date(now.getTime() - PREVIOUS_CONFIGURATION_MS).toISOString();

  const abandoned = await db
    .update(runs)
    .set({
      status: 'cancelled',
      status_reason: 'abandoned',
      completed_at: now.toISOString(),
    })
    .where(
      and(
        inArray(runs.status, [
          'starting',
          'running',
          'needs_input',
          'verifying',
          'publish_conflict',
        ]),
        lt(runs.updated_at, abandonedBefore)
      )
    )
    .returning({ id: runs.id });

  await db
    .update(runs)
    .set({
      status: 'cancelled',
      status_reason: 'draft_deleted',
      completed_at: now.toISOString(),
    })
    .where(
      and(inArray(runs.status, [...OPEN_SETUP_RUN_STATUSES]), isNull(runs.draft_environment_id))
    );

  const staleDraftRows = await db
    .select({
      runId: runs.id,
      userId: runs.owned_by_user_id,
      organizationId: runs.owned_by_organization_id,
    })
    .from(runs)
    .innerJoin(environments, eq(environments.id, runs.draft_environment_id))
    .where(
      and(
        inArray(runs.status, ['cancelled', 'failed', 'reverted']),
        lt(runs.updated_at, staleDraftBefore),
        eq(environments.is_draft, true)
      )
    );
  let draftsDeleted = 0;
  for (const candidate of staleDraftRows) {
    const owner: EnvironmentOwner | null = candidate.organizationId
      ? { type: 'organization', id: candidate.organizationId }
      : candidate.userId
        ? { type: 'user', id: candidate.userId }
        : null;
    if (!owner) continue;
    draftsDeleted += await db
      .transaction(async tx => {
        await lockOwnerOrganization(tx, owner);
        const run = await lockSetupRun(tx, candidate.runId, owner);
        if (
          !['cancelled', 'failed', 'reverted'].includes(run.status) ||
          new Date(run.updated_at).getTime() >= new Date(staleDraftBefore).getTime()
        )
          return 0;
        const draft = await readDraftEnvironment(tx, run.draft_environment_id, owner);
        if (!draft) return 0;
        if (isOpenSetupRunStatus(run.status)) {
          await tx
            .update(runs)
            .set({
              status: 'cancelled',
              status_reason: 'draft_deleted',
              completed_at: now.toISOString(),
            })
            .where(eq(runs.id, run.id));
        }
        const deleted = await tx
          .delete(environments)
          .where(eq(environments.id, draft.id))
          .returning({ id: environments.id });
        return deleted.length;
      })
      .catch(error => {
        // A soft-deleted organization or concurrently deleted run must not block retention cleanup.
        if (error instanceof TRPCError && error.code === 'NOT_FOUND') return 0;
        throw error;
      });
  }

  const previousConfigurationsCleared = await db
    .update(runs)
    .set({ previous_configuration: null })
    .where(
      and(
        eq(runs.status, 'published'),
        isNotNull(runs.previous_configuration),
        lt(runs.completed_at, previousBefore)
      )
    )
    .returning({ id: runs.id });

  return {
    abandoned: abandoned.length,
    draftsDeleted,
    previousConfigurationsCleared: previousConfigurationsCleared.length,
  };
}

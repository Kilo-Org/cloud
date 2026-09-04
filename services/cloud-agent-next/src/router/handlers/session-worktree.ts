import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import {
  admitOperation,
  markReconcilePending,
  recordOperationProgress,
  settleOperation,
} from '@kilocode/db/operation-ledger';
import { cli_sessions_v2, type OperationLedgerRow } from '@kilocode/db/schema';
import {
  cloudAgentWorktreeIdSchema,
  sessionIdSchema as kiloSessionIdSchema,
  type CloudAgentWorktreeId,
} from '@kilocode/session-ingest-contracts';
import { normalizeGitUrl } from '@kilocode/worker-utils';
import {
  createRuntimeAuthorization,
  sealRuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization';
import { verifyKiloTokenForPolicy } from '@kilocode/worker-utils/kilo-token-policy';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getPgDb } from '../../db/pg.js';
import {
  CurrentSessionMetadataSchema,
  type SessionMetadata,
} from '../../persistence/session-metadata.js';
import { logControlDiagnostic } from '../../sandbox-control/diagnostics.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { generateSessionId, isControlPlaneOwner } from '../../session-plane.js';
import {
  assertSessionOperationIdentity,
  assertRuntimeIsolationAdmission,
  SESSION_CREATE_INTENT_FINGERPRINT_KEY,
} from '../../session/session-registration.js';
import type { TRPCContext } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import { generateKiloSessionId } from '../../utils/kilo-session-id.js';
import { sha256Hex } from '../../utils/sha256.js';
import { getWorktreeWorkspacePath } from '../../workspace.js';
import { internalApiProtectedProcedure } from '../auth.js';
import { resolveSecret } from '../../auth.js';
import { assertOrganizationMembership } from './organization-membership.js';

const workspaceSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);

export const CreateWorktreeChatInput = z
  .object({
    sourceKiloSessionId: kiloSessionIdSchema,
    sourceCloudAgentSessionId: workspaceSessionIdSchema,
    operationKey: z.uuid(),
    kilocodeOrganizationId: z.uuid().optional(),
    clientProvenance: z.literal('browser'),
  })
  .strict();

export const CreateWorktreeChatOutput = z
  .object({
    cloudAgentSessionId: workspaceSessionIdSchema,
    kiloSessionId: kiloSessionIdSchema,
    worktreeId: cloudAgentWorktreeIdSchema,
    replayed: z.boolean().optional(),
  })
  .strict();

const ownershipRowSchema = z
  .object({
    kiloSessionId: kiloSessionIdSchema,
    cloudAgentSessionId: workspaceSessionIdSchema,
    userId: z.string().min(1),
    organizationId: z.uuid().nullable(),
    worktreeId: cloudAgentWorktreeIdSchema.nullable(),
    createdOnPlatform: z.string().min(1),
    parentSessionId: z.string().nullable(),
    cloudAgentSessionScopeId: workspaceSessionIdSchema.nullable(),
    gitUrl: z.string().nullable(),
  })
  .strict();

const operationProgressSchema = CreateWorktreeChatOutput.omit({ replayed: true })
  .extend({
    [SESSION_CREATE_INTENT_FINGERPRINT_KEY]: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const ingestResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ready'),
      clone: z
        .object({
          sessionId: kiloSessionIdSchema,
          copiedItemCount: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  z.object({ status: z.literal('in_progress') }).strict(),
  z.object({ status: z.literal('rejected'), code: z.string().min(1) }).strict(),
]);

const registrationResultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true) }).strip(),
  z.object({ success: z.literal(false), error: z.string().optional() }).strip(),
]);

type WorktreeInput = z.infer<typeof CreateWorktreeChatInput>;
type WorktreeResult = z.infer<typeof CreateWorktreeChatOutput>;
type OwnershipRow = z.infer<typeof ownershipRowSchema>;
type OperationProgress = z.infer<typeof operationProgressSchema>;
type WorktreeSource = {
  ownership: OwnershipRow;
  metadata: SessionMetadata;
  workspace: NonNullable<SessionMetadata['workspace']> & {
    sandboxId: NonNullable<NonNullable<SessionMetadata['workspace']>['sandboxId']>;
    sandboxProvider: NonNullable<NonNullable<SessionMetadata['workspace']>['sandboxProvider']>;
  };
  repository: NonNullable<SessionMetadata['repository']>;
  worktreeId: CloudAgentWorktreeId;
};

const WORKTREE_CREATE_LEDGER_LEASE_SECONDS = 120;

function sourceRejected(): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message: 'worktree_source_not_eligible' });
}

function operationConflict(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: 'operation_key_reuse_mismatch' });
}

function creationInProgress(): TRPCError {
  return new TRPCError({ code: 'CONFLICT', message: 'creation_in_progress' });
}

function creationFailed(): TRPCError {
  return new TRPCError({ code: 'BAD_REQUEST', message: 'worktree_chat_creation_failed' });
}

async function findOwnershipRow(
  db: WorkerDb,
  userId: string,
  kiloSessionId: string,
  cloudAgentSessionId: string
): Promise<OwnershipRow | null> {
  const [row] = await db
    .select({
      kiloSessionId: cli_sessions_v2.session_id,
      cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
      userId: cli_sessions_v2.kilo_user_id,
      organizationId: cli_sessions_v2.organization_id,
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      createdOnPlatform: cli_sessions_v2.created_on_platform,
      parentSessionId: cli_sessions_v2.parent_session_id,
      cloudAgentSessionScopeId: cli_sessions_v2.cloud_agent_session_scope_id,
      gitUrl: cli_sessions_v2.git_url,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, userId),
        eq(cli_sessions_v2.session_id, kiloSessionId),
        eq(cli_sessions_v2.cloud_agent_session_id, cloudAgentSessionId)
      )
    )
    .limit(1);

  if (!row) return null;
  const parsed = ownershipRowSchema.safeParse(row);
  if (!parsed.success) throw sourceRejected();
  return parsed.data;
}

function canonicalRepositoryUrl(repository: WorktreeSource['repository']): string {
  return normalizeGitUrl(
    repository.type === 'github' ? `https://github.com/${repository.repo}` : repository.url
  );
}

async function loadWorktreeSource(
  db: WorkerDb,
  ctx: TRPCContext,
  input: WorktreeInput
): Promise<WorktreeSource> {
  if (ctx.botId !== undefined) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
  }

  if (input.kilocodeOrganizationId) {
    await assertOrganizationMembership(db, ctx.userId, input.kilocodeOrganizationId);
  }

  const ownership = await findOwnershipRow(
    db,
    ctx.userId,
    input.sourceKiloSessionId,
    input.sourceCloudAgentSessionId
  );
  if (!ownership || ownership.organizationId !== (input.kilocodeOrganizationId ?? null)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
  }

  const worktreeId = ownership.worktreeId;
  if (
    !worktreeId ||
    ownership.parentSessionId !== null ||
    ownership.cloudAgentSessionScopeId !== input.sourceCloudAgentSessionId ||
    ownership.createdOnPlatform !== 'cloud-agent-web' ||
    !isControlPlaneOwner(ctx.env, {
      userId: ctx.userId,
      orgId: input.kilocodeOrganizationId,
    })
  ) {
    throw sourceRejected();
  }

  const rawMetadata = await withDORetry(
    () => getSandboxSessionStub(ctx.env, ctx.userId, input.sourceCloudAgentSessionId),
    stub => stub.getMetadata(),
    'getMetadata'
  );
  const parsedMetadata = CurrentSessionMetadataSchema.safeParse(rawMetadata);
  if (!parsedMetadata.success) throw sourceRejected();

  const metadata = parsedMetadata.data;
  const workspace = metadata.workspace;
  const repository = metadata.repository;
  if (
    !workspace ||
    !repository ||
    !workspace.sandboxId ||
    !workspace.sandboxProvider ||
    !metadata.agent?.mode ||
    !metadata.agent.model ||
    metadata.identity.userId !== ctx.userId ||
    metadata.identity.orgId !== input.kilocodeOrganizationId ||
    metadata.identity.sessionId !== input.sourceCloudAgentSessionId ||
    metadata.auth.kiloSessionId !== input.sourceKiloSessionId ||
    metadata.identity.createdOnPlatform !== 'cloud-agent-web' ||
    metadata.identity.botId !== undefined ||
    metadata.devcontainer !== undefined ||
    workspace.devcontainerRequested === true ||
    workspace.worktreeId !== worktreeId ||
    workspace.workspacePath !==
      getWorktreeWorkspacePath(input.kilocodeOrganizationId, ctx.userId, worktreeId) ||
    (ownership.gitUrl !== null &&
      normalizeGitUrl(ownership.gitUrl) !== canonicalRepositoryUrl(repository))
  ) {
    throw sourceRejected();
  }

  return {
    ownership,
    metadata,
    workspace: {
      ...workspace,
      sandboxId: workspace.sandboxId,
      sandboxProvider: workspace.sandboxProvider,
    },
    repository,
    worktreeId,
  };
}

async function worktreeIntentFingerprint(
  input: WorktreeInput,
  worktreeId: CloudAgentWorktreeId
): Promise<string> {
  return sha256Hex(
    JSON.stringify({
      sourceKiloSessionId: input.sourceKiloSessionId,
      sourceCloudAgentSessionId: input.sourceCloudAgentSessionId,
      organizationId: input.kilocodeOrganizationId ?? null,
      worktreeId,
      clientProvenance: input.clientProvenance,
    })
  );
}

function readOperationProgress(
  row: OperationLedgerRow,
  source: WorktreeSource,
  fingerprint: string
): OperationProgress | undefined {
  if (row.canonical_result === null) return undefined;
  const progress = operationProgressSchema.safeParse(row.canonical_result);
  if (
    !progress.success ||
    progress.data.worktreeId !== source.worktreeId ||
    progress.data[SESSION_CREATE_INTENT_FINGERPRINT_KEY] !== fingerprint
  ) {
    throw operationConflict();
  }
  return progress.data;
}

function resultFromProgress(progress: OperationProgress, replayed = false): WorktreeResult {
  const result = {
    cloudAgentSessionId: progress.cloudAgentSessionId,
    kiloSessionId: progress.kiloSessionId,
    worktreeId: progress.worktreeId,
  };
  return replayed ? { ...result, replayed: true } : result;
}

type WorktreeRuntimeAuthorization = { token: string; seal: string } | undefined;

/**
 * Establish whether the current caller presented modern control authority.
 * This deliberately verifies the token instead of inferring its type from an
 * untrusted decoded JWT payload.  The actual authorization is re-created for
 * each registration RPC below, which also re-checks principal and membership
 * bindings.
 */
async function requiresRuntimeAuthorization(ctx: TRPCContext): Promise<boolean> {
  const secret = await resolveSecret(ctx.env.NEXTAUTH_SECRET);
  if (!secret) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Authentication unavailable' });
  }
  try {
    const verified = await verifyKiloTokenForPolicy(ctx.authToken, secret, {
      audience: 'cloud-agent-next',
      mode: 'allow-legacy',
    });
    const modern =
      verified.claims.tokenPurpose !== undefined ||
      verified.claims.credentialExchange !== undefined ||
      verified.claims.runtimeAdmission !== undefined;
    if (modern && verified.claims.runtimeAdmission === undefined) {
      throw new Error('Missing runtime admission');
    }
    return modern;
  } catch {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Runtime authorization denied' });
  }
}

async function createDestinationRuntimeAuthorization(
  ctx: TRPCContext,
  progress: OperationProgress,
  organizationId: string | undefined
): Promise<WorktreeRuntimeAuthorization> {
  if (!(await requiresRuntimeAuthorization(ctx))) return undefined;

  const secret = await resolveSecret(ctx.env.NEXTAUTH_SECRET);
  if (!secret) {
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Authentication unavailable' });
  }
  try {
    const created = await createRuntimeAuthorization({
      token: ctx.authToken,
      secret,
      connectionString: ctx.env.HYPERDRIVE.connectionString,
      resourceKind: 'cloud-agent-next',
      resourceId: progress.cloudAgentSessionId,
      ...(organizationId ? { organizationId } : {}),
    });
    return {
      token: created.token,
      seal: await sealRuntimeAuthorization(created.authorization, secret),
    };
  } catch {
    // Membership, principal, and token admission can all change between a
    // lost response and a replay. Never revive a destination on stale control
    // authority.
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Runtime authorization denied' });
  }
}

async function assertNewDestinationRuntimeIsolation(ctx: TRPCContext): Promise<void> {
  if (await requiresRuntimeAuthorization(ctx)) assertRuntimeIsolationAdmission(ctx.env);
}

function buildRegistrationInput(
  source: WorktreeSource,
  ctx: TRPCContext,
  progress: OperationProgress,
  runtimeAuthorization: WorktreeRuntimeAuthorization
): Parameters<ReturnType<typeof getSandboxSessionStub>['registerSession']>[0] {
  const repository = { ...source.repository };
  if ('token' in repository) delete repository.token;

  const workspace = { ...source.workspace };
  delete workspace.providerRuntime;

  return {
    identity: { ...source.metadata.identity, sessionId: progress.cloudAgentSessionId },
    auth: {
      kiloSessionId: progress.kiloSessionId,
      kilocodeToken: runtimeAuthorization?.token ?? ctx.authToken,
    },
    agent: source.metadata.agent,
    repository,
    workspace,
    ...(source.metadata.profile ? { profile: source.metadata.profile } : {}),
    ...(source.metadata.finalization ? { finalization: source.metadata.finalization } : {}),
    ...(runtimeAuthorization ? { runtimeAuthorizationSeal: runtimeAuthorization.seal } : {}),
  };
}

async function assertDestinationRuntimeAuthorizationActive(
  ctx: TRPCContext,
  sessionId: string
): Promise<void> {
  if (!(await requiresRuntimeAuthorization(ctx))) return;
  const status = await withDORetry(
    () => getSandboxSessionStub(ctx.env, ctx.userId, sessionId),
    stub => stub.getRuntimeAuthorizationStatus(),
    'getRuntimeAuthorizationStatus'
  );
  if (status !== 'active') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Runtime authorization denied' });
  }
}

function assertRegisteredMetadata(
  rawMetadata: unknown,
  source: WorktreeSource,
  progress: OperationProgress
): void {
  const parsed = CurrentSessionMetadataSchema.safeParse(rawMetadata);
  if (!parsed.success) throw operationConflict();

  const metadata = parsed.data;
  const workspace = metadata.workspace;
  if (
    metadata.identity.sessionId !== progress.cloudAgentSessionId ||
    metadata.identity.userId !== source.metadata.identity.userId ||
    metadata.identity.orgId !== source.metadata.identity.orgId ||
    metadata.identity.createdOnPlatform !== source.metadata.identity.createdOnPlatform ||
    metadata.auth.kiloSessionId !== progress.kiloSessionId ||
    !workspace ||
    workspace.worktreeId !== source.worktreeId ||
    workspace.workspacePath !== source.workspace.workspacePath ||
    workspace.sandboxId !== source.workspace.sandboxId ||
    workspace.sandboxProvider !== source.workspace.sandboxProvider ||
    workspace.branchName !== source.workspace.branchName ||
    JSON.stringify(workspace.sandboxRoute) !== JSON.stringify(source.workspace.sandboxRoute) ||
    !metadata.repository ||
    canonicalRepositoryUrl(metadata.repository) !== canonicalRepositoryUrl(source.repository) ||
    metadata.repository.upstreamBranch !== source.repository.upstreamBranch
  ) {
    throw operationConflict();
  }
}

async function markPending(db: WorkerDb, rowId: string): Promise<void> {
  const startedAt = Date.now();
  try {
    const row = await markReconcilePending(db, { rowId });
    logControlDiagnostic('worktree_chat_reconciliation', {
      operationRowId: rowId,
      result: row?.status === 'reconcile_pending' ? 'pending' : 'not_pending',
      durationMs: Date.now() - startedAt,
    });
  } catch {
    logControlDiagnostic(
      'worktree_chat_reconciliation',
      {
        operationRowId: rowId,
        result: 'mark_failed',
        stage: 'reconciliation_mark',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    return;
  }
}

async function createOwnershipRow(
  db: WorkerDb,
  rowId: string,
  source: WorktreeSource,
  ctx: TRPCContext,
  progress: OperationProgress
): Promise<void> {
  const startedAt = Date.now();
  const diagnostic = {
    operationRowId: rowId,
    worktreeId: source.worktreeId,
    sourceCloudAgentSessionId: source.ownership.cloudAgentSessionId,
    sourceKiloSessionId: source.ownership.kiloSessionId,
    cloudAgentSessionId: progress.cloudAgentSessionId,
    kiloSessionId: progress.kiloSessionId,
  };
  let response: unknown;
  try {
    response = await ctx.env.SESSION_INGEST.createSessionForCloudAgent({
      sessionId: progress.kiloSessionId,
      kiloUserId: ctx.userId,
      cloudAgentSessionId: progress.cloudAgentSessionId,
      cloudAgentWorktreeId: source.worktreeId,
      cloudAgentWorktreeLocation: {
        sandboxId: source.workspace.sandboxId,
        provider: source.workspace.sandboxProvider,
      },
      organizationId: source.ownership.organizationId ?? undefined,
      createdOnPlatform: source.ownership.createdOnPlatform,
      title: `New session - ${new Date().toISOString()}`,
      gitUrl: source.ownership.gitUrl ?? canonicalRepositoryUrl(source.repository),
    });
  } catch (error) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'ownership',
        reason: 'ownership_outcome_unknown',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    await markPending(db, rowId);
    throw error;
  }

  const parsed = ingestResultSchema.safeParse(response);
  if (!parsed.success || parsed.data.status === 'in_progress') {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'ownership',
        reason: parsed.success ? 'ownership_in_progress' : 'ownership_response_invalid',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    await markPending(db, rowId);
    throw creationInProgress();
  }
  if (parsed.data.status === 'rejected') {
    try {
      const settlement = await settleOperation(db, {
        rowId,
        status: 'failed',
        outcomeCode: 'ownership_row_rejected',
      });
      logControlDiagnostic('worktree_chat_settlement', {
        ...diagnostic,
        requestedStatus: 'failed',
        outcomeCode: 'ownership_row_rejected',
        settled: settlement.settled,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logControlDiagnostic(
        'worktree_chat_settlement',
        {
          ...diagnostic,
          result: 'failed',
          stage: 'ownership_settlement',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      throw error;
    }
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'rejected',
        stage: 'ownership',
        reason: 'ownership_row_rejected',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    throw creationFailed();
  }
  if (
    parsed.data.clone.sessionId !== progress.kiloSessionId ||
    parsed.data.clone.copiedItemCount !== 0
  ) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'ownership',
        reason: 'ownership_result_mismatch',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    await markPending(db, rowId);
    throw creationInProgress();
  }
}

async function completeOperation(
  db: WorkerDb,
  rowId: string,
  progress: OperationProgress
): Promise<void> {
  const startedAt = Date.now();
  const diagnostic = {
    operationRowId: rowId,
    worktreeId: progress.worktreeId,
    cloudAgentSessionId: progress.cloudAgentSessionId,
    kiloSessionId: progress.kiloSessionId,
  };
  logControlDiagnostic('worktree_chat_settlement', {
    ...diagnostic,
    requestedStatus: 'completed',
    result: 'started',
  });
  try {
    const settlement = await settleOperation(db, {
      rowId,
      status: 'completed',
      outcomeCode: 'ok',
      canonicalResult: resultFromProgress(progress),
    });
    logControlDiagnostic('worktree_chat_settlement', {
      ...diagnostic,
      requestedStatus: 'completed',
      outcomeCode: 'ok',
      settled: settlement.settled,
      durationMs: Date.now() - startedAt,
    });
    if (!settlement.settled) throw creationInProgress();
  } catch (error) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'completion_settlement',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    await markPending(db, rowId);
    throw error;
  }
}

async function registerWorktreeSession(
  db: WorkerDb,
  rowId: string,
  source: WorktreeSource,
  ctx: TRPCContext,
  progress: OperationProgress
): Promise<void> {
  const startedAt = Date.now();
  const diagnostic = {
    operationRowId: rowId,
    worktreeId: source.worktreeId,
    sourceCloudAgentSessionId: source.ownership.cloudAgentSessionId,
    sourceKiloSessionId: source.ownership.kiloSessionId,
    cloudAgentSessionId: progress.cloudAgentSessionId,
    kiloSessionId: progress.kiloSessionId,
  };
  let registrationAttempted = false;
  let response: unknown;

  try {
    response = await withDORetry(
      () => getSandboxSessionStub(ctx.env, ctx.userId, progress.cloudAgentSessionId),
      async stub => {
        if (registrationAttempted) {
          const existing = await stub.getMetadata();
          if (existing) {
            assertRegisteredMetadata(existing, source, progress);
            await assertDestinationRuntimeAuthorizationActive(ctx, progress.cloudAgentSessionId);
            logControlDiagnostic('worktree_chat_reconciliation', {
              ...diagnostic,
              result: 'registration_recovered',
              durationMs: Date.now() - startedAt,
            });
            return { success: true };
          }
        }
        registrationAttempted = true;
        await assertNewDestinationRuntimeIsolation(ctx);
        const runtimeAuthorization = await createDestinationRuntimeAuthorization(
          ctx,
          progress,
          source.ownership.organizationId ?? undefined
        );
        return stub.registerSession(
          buildRegistrationInput(source, ctx, progress, runtimeAuthorization)
        );
      },
      'registerSession'
    );
  } catch (error) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'registration',
        reason: 'registration_outcome_unknown',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    await markPending(db, rowId);
    throw error;
  }

  const result = registrationResultSchema.safeParse(response);
  if (!result.success) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'registration',
        reason: 'registration_response_invalid',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    await markPending(db, rowId);
    throw creationInProgress();
  }
  if (!result.data.success) {
    try {
      await ctx.env.SESSION_INGEST.deleteSessionForCloudAgent({
        sessionId: progress.kiloSessionId,
        kiloUserId: ctx.userId,
        onlyIfEmpty: true,
      });
    } catch (error) {
      logControlDiagnostic(
        'worktree_chat_result',
        {
          ...diagnostic,
          result: 'reconciliation_pending',
          stage: 'registration_cleanup',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      await markPending(db, rowId);
      throw error;
    }
    try {
      const settlement = await settleOperation(db, {
        rowId,
        status: 'failed',
        outcomeCode: 'registration_rejected',
      });
      logControlDiagnostic('worktree_chat_settlement', {
        ...diagnostic,
        requestedStatus: 'failed',
        outcomeCode: 'registration_rejected',
        settled: settlement.settled,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      logControlDiagnostic(
        'worktree_chat_settlement',
        {
          ...diagnostic,
          result: 'failed',
          stage: 'registration_settlement',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      throw error;
    }
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'rejected',
        stage: 'registration',
        reason: 'registration_rejected',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'worktree_chat_registration_failed',
    });
  }

  await completeOperation(db, rowId, progress);
}

async function executeWorktreeCreate(
  db: WorkerDb,
  row: OperationLedgerRow,
  source: WorktreeSource,
  ctx: TRPCContext,
  fingerprint: string
): Promise<WorktreeResult> {
  const startedAt = Date.now();
  await assertNewDestinationRuntimeIsolation(ctx);
  const progress = operationProgressSchema.parse({
    cloudAgentSessionId: generateSessionId('control'),
    kiloSessionId: generateKiloSessionId(),
    worktreeId: source.worktreeId,
    [SESSION_CREATE_INTENT_FINGERPRINT_KEY]: fingerprint,
  });
  const diagnostic = {
    operationRowId: row.id,
    worktreeId: source.worktreeId,
    sourceCloudAgentSessionId: source.ownership.cloudAgentSessionId,
    sourceKiloSessionId: source.ownership.kiloSessionId,
    cloudAgentSessionId: progress.cloudAgentSessionId,
    kiloSessionId: progress.kiloSessionId,
  };
  try {
    const recorded = await recordOperationProgress(db, row.id, progress);
    if (!recorded) throw creationInProgress();
  } catch (error) {
    logControlDiagnostic(
      'worktree_chat_result',
      {
        ...diagnostic,
        result: 'reconciliation_pending',
        stage: 'progress_recording',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    throw error;
  }
  logControlDiagnostic('worktree_chat_progress', {
    ...diagnostic,
    result: 'recorded',
    durationMs: Date.now() - startedAt,
  });
  await createOwnershipRow(db, row.id, source, ctx, progress);
  await registerWorktreeSession(db, row.id, source, ctx, progress);
  logControlDiagnostic('worktree_chat_result', {
    ...diagnostic,
    result: 'new',
    durationMs: Date.now() - startedAt,
  });
  return resultFromProgress(progress);
}

async function reconcileWorktreeCreate(
  db: WorkerDb,
  row: OperationLedgerRow,
  source: WorktreeSource,
  ctx: TRPCContext,
  progress: OperationProgress | undefined,
  fingerprint: string
): Promise<WorktreeResult> {
  const startedAt = Date.now();
  const diagnostic = {
    operationRowId: row.id,
    worktreeId: source.worktreeId,
    sourceCloudAgentSessionId: source.ownership.cloudAgentSessionId,
    sourceKiloSessionId: source.ownership.kiloSessionId,
    cloudAgentSessionId: progress?.cloudAgentSessionId,
    kiloSessionId: progress?.kiloSessionId,
  };
  logControlDiagnostic('worktree_chat_reconciliation', {
    ...diagnostic,
    result: progress ? 'started' : 'no_progress',
  });
  if (!progress) return executeWorktreeCreate(db, row, source, ctx, fingerprint);

  const existingMetadata = await withDORetry(
    () => getSandboxSessionStub(ctx.env, ctx.userId, progress.cloudAgentSessionId),
    stub => stub.getMetadata(),
    'getMetadata'
  ).catch(error => {
    logControlDiagnostic(
      'worktree_chat_reconciliation',
      {
        ...diagnostic,
        result: 'failed',
        stage: 'reconciliation_metadata_read',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    throw error;
  });
  if (existingMetadata) {
    try {
      assertRegisteredMetadata(existingMetadata, source, progress);
    } catch (error) {
      logControlDiagnostic(
        'worktree_chat_result',
        {
          ...diagnostic,
          result: 'rejected',
          stage: 'reconciliation_metadata',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      throw error;
    }
    await assertDestinationRuntimeAuthorizationActive(ctx, progress.cloudAgentSessionId);
  } else {
    await assertNewDestinationRuntimeIsolation(ctx);
  }

  const ownership = await findOwnershipRow(
    db,
    ctx.userId,
    progress.kiloSessionId,
    progress.cloudAgentSessionId
  ).catch(error => {
    logControlDiagnostic(
      'worktree_chat_reconciliation',
      {
        ...diagnostic,
        result: 'failed',
        stage: 'reconciliation_ownership_read',
        durationMs: Date.now() - startedAt,
      },
      'warn'
    );
    throw error;
  });
  logControlDiagnostic('worktree_chat_reconciliation', {
    ...diagnostic,
    result: 'observed',
    hasRegisteredMetadata: Boolean(existingMetadata),
    hasOwnership: Boolean(ownership),
    durationMs: Date.now() - startedAt,
  });
  if (ownership) {
    if (
      ownership.organizationId !== source.ownership.organizationId ||
      ownership.worktreeId !== source.worktreeId ||
      ownership.parentSessionId !== null ||
      ownership.cloudAgentSessionScopeId !== progress.cloudAgentSessionId
    ) {
      logControlDiagnostic(
        'worktree_chat_result',
        {
          ...diagnostic,
          result: 'rejected',
          stage: 'reconciliation_ownership',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      throw operationConflict();
    }
  } else {
    await createOwnershipRow(db, row.id, source, ctx, progress);
  }

  if (existingMetadata) {
    await completeOperation(db, row.id, progress);
  } else {
    await registerWorktreeSession(db, row.id, source, ctx, progress);
  }

  logControlDiagnostic('worktree_chat_result', {
    ...diagnostic,
    result: 'replayed',
    durationMs: Date.now() - startedAt,
  });
  return resultFromProgress(progress, true);
}

const createWorktreeChatHandler = internalApiProtectedProcedure
  .input(CreateWorktreeChatInput)
  .output(CreateWorktreeChatOutput)
  .mutation(async ({ input, ctx }) => {
    const startedAt = Date.now();
    const db = getPgDb(ctx.env);
    const source = await loadWorktreeSource(db, ctx, input);
    const fingerprint = await worktreeIntentFingerprint(input, source.worktreeId);
    const admission = await admitOperation(db, {
      userId: ctx.userId,
      orgId: input.kilocodeOrganizationId,
      domain: 'session',
      intent: 'create_worktree_chat',
      operationKey: input.operationKey,
      resourceKey: source.worktreeId,
      taxonomy: 'safe-retry',
      leaseSeconds: WORKTREE_CREATE_LEDGER_LEASE_SECONDS,
    }).catch(error => {
      logControlDiagnostic(
        'worktree_chat_admission',
        {
          operationKey: input.operationKey,
          worktreeId: source.worktreeId,
          sourceCloudAgentSessionId: input.sourceCloudAgentSessionId,
          sourceKiloSessionId: input.sourceKiloSessionId,
          result: 'failed',
          stage: 'admission',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      throw error;
    });
    const diagnostic = {
      operationKey: input.operationKey,
      operationRowId: admission.row.id,
      worktreeId: source.worktreeId,
      sourceCloudAgentSessionId: input.sourceCloudAgentSessionId,
      sourceKiloSessionId: input.sourceKiloSessionId,
      admission: admission.admission,
    };
    logControlDiagnostic('worktree_chat_admission', {
      ...diagnostic,
      durationMs: Date.now() - startedAt,
    });

    let progress: OperationProgress | undefined;
    try {
      assertSessionOperationIdentity(admission.row, {
        userId: ctx.userId,
        intent: 'create_worktree_chat',
        organizationId: input.kilocodeOrganizationId,
        resourceKey: source.worktreeId,
      });
      progress = readOperationProgress(admission.row, source, fingerprint);
    } catch (error) {
      logControlDiagnostic(
        'worktree_chat_result',
        {
          ...diagnostic,
          result: 'rejected',
          stage: 'operation_identity',
          durationMs: Date.now() - startedAt,
        },
        'warn'
      );
      throw error;
    }
    const resultDiagnostic = {
      ...diagnostic,
      cloudAgentSessionId: progress?.cloudAgentSessionId,
      kiloSessionId: progress?.kiloSessionId,
    };

    switch (admission.admission) {
      case 'admitted':
        if (progress) {
          logControlDiagnostic(
            'worktree_chat_result',
            {
              ...resultDiagnostic,
              result: 'rejected',
              stage: 'admission',
              reason: 'unexpected_progress',
              durationMs: Date.now() - startedAt,
            },
            'warn'
          );
          throw operationConflict();
        }
        return executeWorktreeCreate(db, admission.row, source, ctx, fingerprint);
      case 'duplicate_settled':
        if (admission.row.status !== 'completed' || !progress) {
          logControlDiagnostic(
            'worktree_chat_result',
            {
              ...resultDiagnostic,
              result: 'rejected',
              stage: 'replay',
              reason: 'settled_result_unavailable',
              durationMs: Date.now() - startedAt,
            },
            'warn'
          );
          throw creationFailed();
        }
        logControlDiagnostic('worktree_chat_result', {
          ...resultDiagnostic,
          result: 'replayed',
          durationMs: Date.now() - startedAt,
        });
        return resultFromProgress(progress, true);
      case 'duplicate_in_flight':
      case 'duplicate_reconcile_in_progress':
        logControlDiagnostic('worktree_chat_result', {
          ...resultDiagnostic,
          result: 'reconciliation_pending',
          stage: 'admission',
          durationMs: Date.now() - startedAt,
        });
        throw creationInProgress();
      case 'takeover':
      case 'duplicate_reconcile_pending':
        return reconcileWorktreeCreate(db, admission.row, source, ctx, progress, fingerprint);
    }
  });

export function createSessionWorktreeHandlers(): {
  createWorktreeChat: typeof createWorktreeChatHandler;
} {
  return { createWorktreeChat: createWorktreeChatHandler };
}

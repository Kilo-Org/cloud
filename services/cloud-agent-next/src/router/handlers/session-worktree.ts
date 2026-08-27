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
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getPgDb } from '../../db/pg.js';
import {
  CurrentSessionMetadataSchema,
  type SessionMetadata,
} from '../../persistence/session-metadata.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { generateSessionId, isControlPlaneOwner } from '../../session-plane.js';
import {
  assertSessionOperationIdentity,
  SESSION_CREATE_INTENT_FINGERPRINT_KEY,
} from '../../session/session-registration.js';
import type { TRPCContext } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import { generateKiloSessionId } from '../../utils/kilo-session-id.js';
import { sha256Hex } from '../../utils/sha256.js';
import { getWorktreeWorkspacePath } from '../../workspace.js';
import { internalApiProtectedProcedure } from '../auth.js';
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
    metadata.finalization?.autoCommit !== false ||
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

function buildRegistrationInput(
  source: WorktreeSource,
  ctx: TRPCContext,
  progress: OperationProgress
): Parameters<ReturnType<typeof getSandboxSessionStub>['registerSession']>[0] {
  const repository = { ...source.repository };
  if ('token' in repository) delete repository.token;

  const workspace = { ...source.workspace };
  delete workspace.providerRuntime;

  return {
    identity: { ...source.metadata.identity, sessionId: progress.cloudAgentSessionId },
    auth: { kiloSessionId: progress.kiloSessionId, kilocodeToken: ctx.authToken },
    agent: source.metadata.agent,
    repository,
    workspace,
    ...(source.metadata.profile ? { profile: source.metadata.profile } : {}),
    finalization: { ...source.metadata.finalization, autoCommit: false },
  };
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
    metadata.finalization?.autoCommit !== false ||
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
  try {
    await markReconcilePending(db, { rowId });
  } catch {
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
    await markPending(db, rowId);
    throw error;
  }

  const parsed = ingestResultSchema.safeParse(response);
  if (!parsed.success || parsed.data.status === 'in_progress') {
    await markPending(db, rowId);
    throw creationInProgress();
  }
  if (parsed.data.status === 'rejected') {
    await settleOperation(db, { rowId, status: 'failed', outcomeCode: 'ownership_row_rejected' });
    throw creationFailed();
  }
  if (
    parsed.data.clone.sessionId !== progress.kiloSessionId ||
    parsed.data.clone.copiedItemCount !== 0
  ) {
    await markPending(db, rowId);
    throw creationInProgress();
  }
}

async function completeOperation(
  db: WorkerDb,
  rowId: string,
  progress: OperationProgress
): Promise<void> {
  try {
    const settlement = await settleOperation(db, {
      rowId,
      status: 'completed',
      outcomeCode: 'ok',
      canonicalResult: resultFromProgress(progress),
    });
    if (!settlement.settled) throw creationInProgress();
  } catch (error) {
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
  const registrationInput = buildRegistrationInput(source, ctx, progress);
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
            return { success: true };
          }
        }
        registrationAttempted = true;
        return stub.registerSession(registrationInput);
      },
      'registerSession'
    );
  } catch (error) {
    await markPending(db, rowId);
    throw error;
  }

  const result = registrationResultSchema.safeParse(response);
  if (!result.success) {
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
      await markPending(db, rowId);
      throw error;
    }
    await settleOperation(db, {
      rowId,
      status: 'failed',
      outcomeCode: 'registration_rejected',
    });
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
  const progress = operationProgressSchema.parse({
    cloudAgentSessionId: generateSessionId('control'),
    kiloSessionId: generateKiloSessionId(),
    worktreeId: source.worktreeId,
    [SESSION_CREATE_INTENT_FINGERPRINT_KEY]: fingerprint,
  });
  const recorded = await recordOperationProgress(db, row.id, progress);
  if (!recorded) throw creationInProgress();
  await createOwnershipRow(db, row.id, source, ctx, progress);
  await registerWorktreeSession(db, row.id, source, ctx, progress);
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
  if (!progress) return executeWorktreeCreate(db, row, source, ctx, fingerprint);

  const existingMetadata = await withDORetry(
    () => getSandboxSessionStub(ctx.env, ctx.userId, progress.cloudAgentSessionId),
    stub => stub.getMetadata(),
    'getMetadata'
  );
  if (existingMetadata) assertRegisteredMetadata(existingMetadata, source, progress);

  const ownership = await findOwnershipRow(
    db,
    ctx.userId,
    progress.kiloSessionId,
    progress.cloudAgentSessionId
  );
  if (ownership) {
    if (
      ownership.organizationId !== source.ownership.organizationId ||
      ownership.worktreeId !== source.worktreeId ||
      ownership.parentSessionId !== null ||
      ownership.cloudAgentSessionScopeId !== progress.cloudAgentSessionId
    ) {
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

  return resultFromProgress(progress, true);
}

const createWorktreeChatHandler = internalApiProtectedProcedure
  .input(CreateWorktreeChatInput)
  .output(CreateWorktreeChatOutput)
  .mutation(async ({ input, ctx }) => {
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
    });

    assertSessionOperationIdentity(admission.row, {
      userId: ctx.userId,
      intent: 'create_worktree_chat',
      organizationId: input.kilocodeOrganizationId,
      resourceKey: source.worktreeId,
    });
    const progress = readOperationProgress(admission.row, source, fingerprint);

    switch (admission.admission) {
      case 'admitted':
        if (progress) throw operationConflict();
        return executeWorktreeCreate(db, admission.row, source, ctx, fingerprint);
      case 'duplicate_settled':
        if (admission.row.status !== 'completed' || !progress) throw creationFailed();
        return resultFromProgress(progress, true);
      case 'duplicate_in_flight':
      case 'duplicate_reconcile_in_progress':
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

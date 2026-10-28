import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import {
  admitOperation,
  getOperation,
  markReconcilePending,
  recordOperationProgress,
  settleOperation,
} from '@kilocode/db/operation-ledger';
import { cli_sessions_v2, cloud_agent_worktrees } from '@kilocode/db/schema';
import {
  clientKiloSessionIdSchema,
  cloudAgentWorktreeIdSchema,
  WORKSPACE_DELETING,
  WORKSPACE_IDENTITY_CONFLICT,
  WORKSPACE_REQUIRES_ROOT_SESSION,
  type CloudAgentWorktreeId,
} from '@kilocode/session-ingest-contracts';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { getPgDb } from '../../db/pg.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import {
  assertSessionOperationIdentity,
  createSessionWithLedger,
} from '../../session/session-registration.js';
import type { SessionCreateRequest } from '../../session/session-requests.js';
import type { Env } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';
import {
  AttachmentsSchema,
  Limits,
  MessageIdSchema,
  ModeSlugSchema,
  modelIdSchema,
  ProfileInputSchema,
  RepositoryInputSchema,
} from '../schemas.js';
import {
  profileInputToSessionProfile,
  repositoryInputToSessionRepository,
} from './session-start.js';
import { preflightSessionCreation } from './session-creation-preflight.js';
import { assertOrganizationMembership } from './organization-membership.js';

/** Authenticated IDE/Agent Manager Session Host origin. */
const AGENT_MANAGER_ORIGIN = 'agent-manager';
const DELETE_LEDGER_LEASE_SECONDS = 120;

const workspaceSessionIdSchema = z.templateLiteral(['workspace_', z.uuid()]);
type HostedWorkspaceSessionId = z.infer<typeof workspaceSessionIdSchema>;
const RequiredProfileInput = ProfileInputSchema.unwrap()
  .extend({ id: z.uuid().describe('Existing Cloud profile to resolve for this workspace') })
  .strict();

export const CreateHostedWorkspaceInput = z
  .object({
    operationKey: z.uuid(),
    clientProvenance: z.literal('agent-manager'),
    repository: RepositoryInputSchema,
    profile: RequiredProfileInput,
    message: z
      .object({
        prompt: z.string().min(1).max(Limits.MAX_PROMPT_LENGTH),
        attachments: AttachmentsSchema.optional(),
        id: MessageIdSchema.optional(),
      })
      .strict(),
    agent: z
      .object({
        mode: ModeSlugSchema,
        model: modelIdSchema,
        variant: z
          .string()
          .max(50)
          .regex(/^[a-zA-Z]+$/)
          .optional(),
      })
      .strict(),
    options: z
      .object({
        kilocodeOrganizationId: z.uuid().optional(),
      })
      .strict()
      .optional(),
    kiloSessionId: clientKiloSessionIdSchema.optional(),
  })
  .strict();

export const CreateHostedWorkspaceOutput = z
  .object({
    workspaceId: cloudAgentWorktreeIdSchema,
    cloudAgentSessionId: workspaceSessionIdSchema,
    kiloSessionId: z.string(),
    messageId: MessageIdSchema,
    replayed: z.boolean().optional(),
  })
  .strict();

export const DeleteHostedWorkspaceSessionInput = z
  .object({
    workspaceId: cloudAgentWorktreeIdSchema,
    sessionId: workspaceSessionIdSchema,
    operationKey: z.uuid(),
  })
  .strict();

export const DeleteHostedWorkspaceSessionOutput = z
  .object({
    success: z.literal(true),
    workspaceId: cloudAgentWorktreeIdSchema,
    sessionId: workspaceSessionIdSchema,
  })
  .strict();

type HostedWorkspaceCreate = z.infer<typeof CreateHostedWorkspaceInput>;
type HostedWorkspaceCreateResult = z.infer<typeof CreateHostedWorkspaceOutput>;

function workspaceIdForSession(cloudAgentSessionId: string): CloudAgentWorktreeId {
  const parsed = cloudAgentWorktreeIdSchema.safeParse(
    `worktree_${cloudAgentSessionId.slice('workspace_'.length)}`
  );
  if (!parsed.success) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'hosted_workspace_creation_failed',
    });
  }
  return parsed.data;
}

export function hostedWorkspaceCreateRequest(input: HostedWorkspaceCreate): SessionCreateRequest {
  return {
    initialTurn: {
      type: 'prompt',
      prompt: input.message.prompt,
      ...(input.message.attachments ? { attachments: input.message.attachments } : {}),
      ...(input.message.id ? { id: input.message.id } : {}),
    },
    agent: input.agent,
    repository: repositoryInputToSessionRepository(input.repository),
    profile: profileInputToSessionProfile(input.profile),
    options: {
      ...(input.options?.kilocodeOrganizationId
        ? { kilocodeOrganizationId: input.options.kilocodeOrganizationId }
        : {}),
      createdOnPlatform: AGENT_MANAGER_ORIGIN,
      clientProvenance: 'agent-manager',
      operationKey: input.operationKey,
      ...(input.kiloSessionId ? { kiloSessionId: input.kiloSessionId } : {}),
    },
  };
}

async function verifyWorkspaceIdentity(
  db: WorkerDb,
  userId: string,
  kiloSessionId: string,
  workspaceId: CloudAgentWorktreeId
): Promise<void> {
  const [row] = await db
    .select({ worktreeId: cli_sessions_v2.cloud_agent_worktree_id })
    .from(cli_sessions_v2)
    .where(
      and(eq(cli_sessions_v2.kilo_user_id, userId), eq(cli_sessions_v2.session_id, kiloSessionId))
    )
    .limit(1);
  if (!row || row.worktreeId !== workspaceId) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: WORKSPACE_IDENTITY_CONFLICT,
    });
  }
}

const createHostedWorkspaceHandler = protectedProcedure
  .input(CreateHostedWorkspaceInput)
  .output(CreateHostedWorkspaceOutput)
  .mutation(async ({ input, ctx }): Promise<HostedWorkspaceCreateResult> => {
    if (ctx.botId !== undefined || ctx.cloudAgentAuthority !== undefined) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
    }
    const request = await preflightSessionCreation(
      hostedWorkspaceCreateRequest(input),
      ctx,
      'createHostedWorkspace'
    );
    const registration = await createSessionWithLedger(
      request,
      { env: ctx.env, userId: ctx.userId, authToken: ctx.authToken, botId: ctx.botId },
      {
        billingOrigin: AGENT_MANAGER_ORIGIN,
        operationKey: input.operationKey,
        includeInitialMessage: true,
        resolveSavedAllocationBeforeAdmission: true,
        startedAt: Date.now(),
      }
    );
    if (!registration.messageId) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'hosted_workspace_creation_failed',
      });
    }
    const workspaceId = workspaceIdForSession(registration.cloudAgentSessionId);
    await verifyWorkspaceIdentity(
      getPgDb(ctx.env),
      ctx.userId,
      registration.kiloSessionId,
      workspaceId
    );
    return {
      workspaceId,
      cloudAgentSessionId: workspaceSessionIdSchema.parse(registration.cloudAgentSessionId),
      kiloSessionId: registration.kiloSessionId,
      messageId: registration.messageId,
      ...(registration.replayed === true ? { replayed: true } : {}),
    };
  });

type HostedWorkspaceRow = {
  sessionId: string;
  cloudAgentSessionId: string;
  organizationId: string | null;
  worktreeId: string | null;
  parentSessionId: string | null;
};

function readDeletionProgress(row: {
  canonical_result: Record<string, unknown> | null;
}): { cloudAgentSessionId: string; kiloSessionId: string } | undefined {
  const result = row.canonical_result;
  if (!result) return undefined;
  const cloudAgentSessionId = result.cloudAgentSessionId;
  const kiloSessionId = result.kiloSessionId;
  if (typeof cloudAgentSessionId !== 'string' || typeof kiloSessionId !== 'string') {
    return undefined;
  }
  return { cloudAgentSessionId, kiloSessionId };
}

async function findHostedWorkspaceSession(
  db: WorkerDb,
  userId: string,
  cloudAgentSessionId: string
): Promise<HostedWorkspaceRow | null> {
  const [row] = await db
    .select({
      sessionId: cli_sessions_v2.session_id,
      cloudAgentSessionId: cli_sessions_v2.cloud_agent_session_id,
      organizationId: cli_sessions_v2.organization_id,
      worktreeId: cli_sessions_v2.cloud_agent_worktree_id,
      parentSessionId: cli_sessions_v2.parent_session_id,
    })
    .from(cli_sessions_v2)
    .where(
      and(
        eq(cli_sessions_v2.kilo_user_id, userId),
        eq(cli_sessions_v2.cloud_agent_session_id, cloudAgentSessionId)
      )
    )
    .limit(1);
  if (!row || row.cloudAgentSessionId === null) return null;
  return { ...row, cloudAgentSessionId: row.cloudAgentSessionId };
}

function deletionConflict(code: string | null | undefined): TRPCError {
  switch (code) {
    case WORKSPACE_REQUIRES_ROOT_SESSION:
      return new TRPCError({ code: 'CONFLICT', message: WORKSPACE_REQUIRES_ROOT_SESSION });
    case WORKSPACE_DELETING:
      return new TRPCError({ code: 'CONFLICT', message: WORKSPACE_DELETING });
    case WORKSPACE_IDENTITY_CONFLICT:
      return new TRPCError({ code: 'NOT_FOUND', message: 'workspace_session_not_found' });
    default:
      return new TRPCError({ code: 'CONFLICT', message: 'session_deletion_failed' });
  }
}

function rpcErrorCode(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function deleteHostedWorkspaceSessionInIngest(input: {
  db: WorkerDb;
  env: Env;
  rowId: string;
  userId: string;
  workspaceId: CloudAgentWorktreeId;
  sessionId: HostedWorkspaceSessionId;
  kiloSessionId: string;
}): Promise<void> {
  try {
    await input.env.SESSION_INGEST.deleteHostedWorkspaceSession({
      kiloUserId: input.userId,
      workspaceId: input.workspaceId,
      sessionId: input.kiloSessionId,
      cloudAgentSessionId: input.sessionId,
    });
  } catch (error) {
    const code = rpcErrorCode(error);
    if (
      code.includes(WORKSPACE_REQUIRES_ROOT_SESSION) ||
      code.includes(WORKSPACE_DELETING) ||
      code.includes(WORKSPACE_IDENTITY_CONFLICT)
    ) {
      await settleOperation(input.db, {
        rowId: input.rowId,
        status: 'failed',
        outcomeCode: code.includes(WORKSPACE_REQUIRES_ROOT_SESSION)
          ? WORKSPACE_REQUIRES_ROOT_SESSION
          : code.includes(WORKSPACE_DELETING)
            ? WORKSPACE_DELETING
            : WORKSPACE_IDENTITY_CONFLICT,
      }).catch(() => undefined);
      throw deletionConflict(code);
    }
    await markReconcilePending(input.db, { rowId: input.rowId }).catch(() => undefined);
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'session_deletion_unavailable',
    });
  }
}

/** Idempotent for a missing ingest row, so a reconcile retry may re-run it. */
async function teardownHostedWorkspaceSession(input: {
  db: WorkerDb;
  env: Env;
  rowId: string;
  userId: string;
  sessionId: HostedWorkspaceSessionId;
}): Promise<void> {
  try {
    await withDORetry(
      () => getSandboxSessionStub(input.env, input.userId, input.sessionId),
      stub => stub.deleteSession(),
      'deleteSession'
    );
  } catch {
    await markReconcilePending(input.db, { rowId: input.rowId }).catch(() => undefined);
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'session_deletion_incomplete',
    });
  }
}

async function settleHostedWorkspaceDeletion(input: {
  db: WorkerDb;
  rowId: string;
  workspaceId: CloudAgentWorktreeId;
  sessionId: HostedWorkspaceSessionId;
  kiloSessionId: string;
}) {
  const settlement = await settleOperation(input.db, {
    rowId: input.rowId,
    status: 'completed',
    outcomeCode: 'ok',
    canonicalResult: {
      workspaceId: input.workspaceId,
      cloudAgentSessionId: input.sessionId,
      kiloSessionId: input.kiloSessionId,
    },
  });
  if (!settlement.settled && settlement.row?.status !== 'completed') {
    throw new TRPCError({ code: 'CONFLICT', message: 'session_deletion_in_progress' });
  }
  return { success: true as const, workspaceId: input.workspaceId, sessionId: input.sessionId };
}

/**
 * Resumes a delete whose ownership row is already gone.
 *
 * The Session Ingest delete commits before the Session DO teardown, so a
 * teardown failure leaves no `cli_sessions_v2` row while the ledger is
 * `reconcile_pending`. Admission is still required here: it is what claims the
 * reconcile lease (which `markReconcilePending` makes claimable immediately),
 * so a retry can re-run the idempotent RPC, retry the teardown and settle.
 */
async function resumeMissingSessionDeletion(input: {
  db: WorkerDb;
  env: Env;
  userId: string;
  organizationId: string | null;
  operationKey: string;
  workspaceId: CloudAgentWorktreeId;
  sessionId: HostedWorkspaceSessionId;
  kiloSessionId: string;
}) {
  const admission = await admitOperation(input.db, {
    userId: input.userId,
    orgId: input.organizationId ?? undefined,
    domain: 'session',
    intent: 'delete_workspace_session',
    operationKey: input.operationKey,
    resourceKey: input.workspaceId,
    taxonomy: 'safe-retry',
    leaseSeconds: DELETE_LEDGER_LEASE_SECONDS,
  });
  assertSessionOperationIdentity(admission.row, {
    userId: input.userId,
    intent: 'delete_workspace_session',
    organizationId: input.organizationId ?? undefined,
    resourceKey: input.workspaceId,
  });
  if (admission.admission === 'duplicate_settled') {
    if (admission.row.status === 'completed') {
      return {
        success: true as const,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
      };
    }
    throw deletionConflict(admission.row.outcome_code);
  }
  if (
    admission.admission === 'duplicate_in_flight' ||
    admission.admission === 'duplicate_reconcile_in_progress'
  ) {
    throw new TRPCError({ code: 'CONFLICT', message: 'session_deletion_in_progress' });
  }

  await deleteHostedWorkspaceSessionInIngest({
    db: input.db,
    env: input.env,
    rowId: admission.row.id,
    userId: input.userId,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    kiloSessionId: input.kiloSessionId,
  });
  await teardownHostedWorkspaceSession({
    db: input.db,
    env: input.env,
    rowId: admission.row.id,
    userId: input.userId,
    sessionId: input.sessionId,
  });
  return settleHostedWorkspaceDeletion({
    db: input.db,
    rowId: admission.row.id,
    workspaceId: input.workspaceId,
    sessionId: input.sessionId,
    kiloSessionId: input.kiloSessionId,
  });
}

const deleteHostedWorkspaceSessionHandler = protectedProcedure
  .input(DeleteHostedWorkspaceSessionInput)
  .output(DeleteHostedWorkspaceSessionOutput)
  .mutation(async ({ input, ctx }) => {
    if (ctx.botId !== undefined || ctx.cloudAgentAuthority !== undefined) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
    }
    const db = getPgDb(ctx.env);
    const [workspace] = await db
      .select({
        organizationId: cloud_agent_worktrees.organization_id,
        deletionStartedAt: cloud_agent_worktrees.deletion_started_at,
      })
      .from(cloud_agent_worktrees)
      .where(
        and(
          eq(cloud_agent_worktrees.worktree_id, input.workspaceId),
          eq(cloud_agent_worktrees.kilo_user_id, ctx.userId)
        )
      )
      .limit(1);
    if (!workspace) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace_not_found' });
    }
    if (workspace.deletionStartedAt !== null) {
      throw new TRPCError({ code: 'CONFLICT', message: WORKSPACE_DELETING });
    }
    if (workspace.organizationId) {
      await assertOrganizationMembership(db, ctx.userId, workspace.organizationId);
    }

    const row = await findHostedWorkspaceSession(db, ctx.userId, input.sessionId);
    if (!row) {
      const existing = await getOperation(db, {
        userId: ctx.userId,
        domain: 'session',
        operationKey: input.operationKey,
      });
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace_session_not_found' });
      }
      assertSessionOperationIdentity(existing, {
        userId: ctx.userId,
        intent: 'delete_workspace_session',
        organizationId: workspace.organizationId ?? undefined,
        resourceKey: input.workspaceId,
      });
      const recorded = readDeletionProgress(existing);
      if (recorded?.cloudAgentSessionId !== input.sessionId) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace_session_not_found' });
      }
      if (existing.status === 'completed') {
        return {
          success: true as const,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
        };
      }
      if (existing.status === 'failed') throw deletionConflict(existing.outcome_code);
      if (!recorded) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace_session_not_found' });
      }

      return resumeMissingSessionDeletion({
        db,
        env: ctx.env,
        userId: ctx.userId,
        organizationId: workspace.organizationId,
        operationKey: input.operationKey,
        workspaceId: input.workspaceId,
        sessionId: input.sessionId,
        kiloSessionId: recorded.kiloSessionId,
      });
    }
    if (row.worktreeId !== input.workspaceId || row.parentSessionId !== null) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace_session_not_found' });
    }
    await requireCurrentSessionAccess({
      env: ctx.env,
      kiloUserId: ctx.userId,
      cloudAgentSessionId: input.sessionId,
      expectedKiloSessionId: row.sessionId,
      expectedOrganizationId: workspace.organizationId,
    });

    const admission = await admitOperation(db, {
      userId: ctx.userId,
      orgId: workspace.organizationId ?? undefined,
      domain: 'session',
      intent: 'delete_workspace_session',
      operationKey: input.operationKey,
      resourceKey: input.workspaceId,
      taxonomy: 'safe-retry',
      leaseSeconds: DELETE_LEDGER_LEASE_SECONDS,
    });
    assertSessionOperationIdentity(admission.row, {
      userId: ctx.userId,
      intent: 'delete_workspace_session',
      organizationId: workspace.organizationId ?? undefined,
      resourceKey: input.workspaceId,
    });

    const recorded = readDeletionProgress(admission.row);
    if (recorded && recorded.cloudAgentSessionId !== input.sessionId) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace_session_not_found' });
    }

    if (admission.admission === 'duplicate_settled') {
      if (admission.row.status === 'completed') {
        return {
          success: true as const,
          workspaceId: input.workspaceId,
          sessionId: input.sessionId,
        };
      }
      throw deletionConflict(admission.row.outcome_code);
    }
    if (
      admission.admission === 'duplicate_in_flight' ||
      admission.admission === 'duplicate_reconcile_in_progress'
    ) {
      throw new TRPCError({ code: 'CONFLICT', message: 'session_deletion_in_progress' });
    }

    if (!recorded) {
      await recordOperationProgress(db, admission.row.id, {
        cloudAgentSessionId: input.sessionId,
        kiloSessionId: row.sessionId,
      });
    }

    const kiloSessionId = recorded?.kiloSessionId ?? row.sessionId;
    await deleteHostedWorkspaceSessionInIngest({
      db,
      env: ctx.env,
      rowId: admission.row.id,
      userId: ctx.userId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      kiloSessionId,
    });
    await teardownHostedWorkspaceSession({
      db,
      env: ctx.env,
      rowId: admission.row.id,
      userId: ctx.userId,
      sessionId: input.sessionId,
    });
    return settleHostedWorkspaceDeletion({
      db,
      rowId: admission.row.id,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      kiloSessionId,
    });
  });

export function createHostedWorkspaceMutationHandlers(): {
  createHostedWorkspace: typeof createHostedWorkspaceHandler;
  deleteHostedWorkspaceSession: typeof deleteHostedWorkspaceSessionHandler;
} {
  return {
    createHostedWorkspace: createHostedWorkspaceHandler,
    deleteHostedWorkspaceSession: deleteHostedWorkspaceSessionHandler,
  };
}

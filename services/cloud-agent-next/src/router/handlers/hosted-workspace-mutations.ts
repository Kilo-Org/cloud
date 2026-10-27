import { TRPCError } from '@trpc/server';
import type { WorkerDb } from '@kilocode/db/client';
import {
  admitOperation,
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

function createRequest(input: HostedWorkspaceCreate): SessionCreateRequest {
  return {
    allowSubagentSessions: false,
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
      createRequest(input),
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
    if (row) {
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
    }

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

    if (admission.admission === 'admitted' && !row) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace_session_not_found' });
    }
    if (!recorded) {
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'workspace_session_not_found' });
      }
      await recordOperationProgress(db, admission.row.id, {
        cloudAgentSessionId: input.sessionId,
        kiloSessionId: row.sessionId,
      });
    }

    if (row) {
      try {
        await ctx.env.SESSION_INGEST.deleteHostedWorkspaceSession({
          kiloUserId: ctx.userId,
          workspaceId: input.workspaceId,
          sessionId: recorded?.kiloSessionId ?? row.sessionId,
          cloudAgentSessionId: input.sessionId,
        });
      } catch (error) {
        const code = rpcErrorCode(error);
        if (
          code.includes(WORKSPACE_REQUIRES_ROOT_SESSION) ||
          code.includes(WORKSPACE_DELETING) ||
          code.includes(WORKSPACE_IDENTITY_CONFLICT)
        ) {
          await settleOperation(db, {
            rowId: admission.row.id,
            status: 'failed',
            outcomeCode: code.includes(WORKSPACE_REQUIRES_ROOT_SESSION)
              ? WORKSPACE_REQUIRES_ROOT_SESSION
              : code.includes(WORKSPACE_DELETING)
                ? WORKSPACE_DELETING
                : WORKSPACE_IDENTITY_CONFLICT,
          }).catch(() => undefined);
          throw deletionConflict(code);
        }
        await markReconcilePending(db, { rowId: admission.row.id }).catch(() => undefined);
        throw new TRPCError({
          code: 'SERVICE_UNAVAILABLE',
          message: 'session_deletion_unavailable',
        });
      }
    }

    try {
      await withDORetry(
        () => getSandboxSessionStub(ctx.env, ctx.userId, input.sessionId),
        stub => stub.deleteSession(),
        'deleteSession'
      );
    } catch {
      await markReconcilePending(db, { rowId: admission.row.id }).catch(() => undefined);
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'session_deletion_incomplete',
      });
    }

    const settlement = await settleOperation(db, {
      rowId: admission.row.id,
      status: 'completed',
      outcomeCode: 'ok',
      canonicalResult: {
        workspaceId: input.workspaceId,
        cloudAgentSessionId: input.sessionId,
        kiloSessionId: recorded?.kiloSessionId ?? row?.sessionId,
      },
    });
    if (!settlement.settled && settlement.row?.status !== 'completed') {
      throw new TRPCError({ code: 'CONFLICT', message: 'session_deletion_in_progress' });
    }
    return { success: true as const, workspaceId: input.workspaceId, sessionId: input.sessionId };
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

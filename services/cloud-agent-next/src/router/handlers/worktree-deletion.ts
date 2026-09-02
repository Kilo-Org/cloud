import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  cloudAgentWorktreeIdSchema,
  cloudAgentWorktreeDeletionStateSchema,
  cloudAgentWorktreeLocationSchema,
  cloudAgentChildSessionLineageSchema,
  sessionIdSchema,
  WORKTREE_RUNTIME_HISTORY_UNAVAILABLE,
  type CloudAgentWorktreeDeletionParams,
  type RecordCloudAgentWorktreeCleanupParams,
} from '@kilocode/session-ingest-contracts';
import { hasOrganizationAccess } from '@kilocode/worker-utils';
import { getPgDb } from '../../db/pg';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub';
import { getSandboxControlStub } from '../../sandbox-control/stub';
import {
  worktreeDeleteResultSchema,
  type WorktreeDeleteResult,
} from '../../shared/sandbox-control-protocol';
import { logControlDiagnostic } from '../../sandbox-control/diagnostics';
import { withDORetry } from '../../utils/do-retry';
import { getWorktreeWorkspacePath } from '../../workspace';
import type { TRPCContext } from '../../types';
import { protectedProcedure } from '../auth';

export const DeleteWorktreeInput = z
  .object({
    worktreeId: cloudAgentWorktreeIdSchema,
    kilocodeOrganizationId: z.uuid().optional(),
  })
  .strict();

export const DeleteWorktreeOutput = z
  .object({
    success: z.literal(true),
    deletedSessionIds: z.array(sessionIdSchema),
  })
  .strict();

export async function deleteWorktreeResources(
  input: z.infer<typeof DeleteWorktreeInput>,
  ctx: TRPCContext
): Promise<z.infer<typeof DeleteWorktreeOutput>> {
  if (ctx.botId !== undefined)
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Worktree access denied' });
  const params: CloudAgentWorktreeDeletionParams = {
    worktreeId: input.worktreeId,
    kiloUserId: ctx.userId,
    ...(input.kilocodeOrganizationId ? { organizationId: input.kilocodeOrganizationId } : {}),
  };
  const startedAt = Date.now();
  let stage = 'authorize';
  let outcome = 'failed';
  let sessionCount: number | undefined;
  let locationCount: number | undefined;
  let errorCode: string | undefined;
  let retryable: boolean | undefined;
  logControlDiagnostic('worktree_deletion', { worktreeId: params.worktreeId, phase: 'started' });
  try {
    if (
      params.organizationId &&
      !(await hasOrganizationAccess(getPgDb(ctx.env), {
        kiloUserId: ctx.userId,
        organizationId: params.organizationId,
      }))
    ) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Worktree access denied' });
    }
    stage = 'begin_deletion';
    let state = cloudAgentWorktreeDeletionStateSchema.parse(
      await ctx.env.SESSION_INGEST.beginCloudAgentWorktreeDeletion(params)
    );
    sessionCount = state.manifest.sessions.length;
    locationCount = state.runtimeLocations.length;
    if (state.completed) {
      outcome = 'replayed';
      return {
        success: true,
        deletedSessionIds: state.manifest.sessions.map(session => session.sessionId),
      };
    }
    const runtimeLocations = [...state.runtimeLocations];
    const directory = getWorktreeWorkspacePath(
      params.organizationId,
      ctx.userId,
      params.worktreeId
    );
    const childSessions: NonNullable<RecordCloudAgentWorktreeCleanupParams['childSessions']> = [];
    stage = 'collect_sessions';
    for (const session of state.manifest.sessions) {
      if (!session.cloudAgentSessionId) continue;
      const cloudAgentSessionId = session.cloudAgentSessionId;
      const rawLocation = await withDORetry(
        () => getSandboxSessionStub(ctx.env, ctx.userId, cloudAgentSessionId),
        stub =>
          stub.beginWorktreeDeletion({
            worktreeId: params.worktreeId,
            ownerId: ctx.userId,
            kiloSessionId: session.sessionId,
            ...(params.organizationId ? { organizationId: params.organizationId } : {}),
          }),
        'beginWorktreeDeletion'
      );
      const children = z.array(cloudAgentChildSessionLineageSchema).parse(
        await withDORetry(
          () => getSandboxSessionStub(ctx.env, ctx.userId, cloudAgentSessionId),
          stub => stub.getWorktreeChildSessions(params.worktreeId),
          'getWorktreeChildSessions'
        )
      );
      childSessions.push(...children.map(child => ({ ...child, cloudAgentSessionId })));
      const location = cloudAgentWorktreeLocationSchema.nullable().parse(rawLocation);
      if (
        location &&
        !runtimeLocations.some(
          item => item.sandboxId === location.sandboxId && item.provider === location.provider
        )
      ) {
        runtimeLocations.push(location);
      }
    }
    stage = 'runtime_history';
    locationCount = runtimeLocations.length;
    if (runtimeLocations.length === 0) throw new Error(WORKTREE_RUNTIME_HISTORY_UNAVAILABLE);
    stage = 'record_manifest';
    state = cloudAgentWorktreeDeletionStateSchema.parse(
      await ctx.env.SESSION_INGEST.recordCloudAgentWorktreeCleanup({
        ...params,
        runtimeLocations,
        directory,
        ...(childSessions.length > 0 ? { childSessions } : {}),
      })
    );
    sessionCount = state.manifest.sessions.length;
    locationCount = state.runtimeLocations.length;
    for (const location of state.runtimeLocations) {
      stage = 'runtime_cleanup';
      const locationStartedAt = Date.now();
      let cleanup: WorktreeDeleteResult | undefined;
      try {
        cleanup = worktreeDeleteResultSchema.parse(
          await withDORetry(
            () => getSandboxControlStub(ctx.env, location.sandboxId),
            stub =>
              stub.deleteWorktreeResources({
                ...params,
                location,
                sessionIds: state.manifest.sessions.map(session => session.sessionId),
              }),
            'deleteWorktreeResources'
          )
        );
      } finally {
        logControlDiagnostic(
          'worktree_cleanup_location',
          {
            worktreeId: params.worktreeId,
            sandboxId: location.sandboxId,
            provider: location.provider,
            result: cleanup ? 'resources_cleaned' : 'failed',
            sessionCount: cleanup?.sessionIds.length,
            durationMs: Date.now() - locationStartedAt,
          },
          cleanup ? 'info' : 'warn'
        );
      }
      stage = 'record_cleanup';
      state = cloudAgentWorktreeDeletionStateSchema.parse(
        await ctx.env.SESSION_INGEST.recordCloudAgentWorktreeCleanup({
          ...params,
          directory,
          sessionIds: cleanup.sessionIds,
        })
      );
      sessionCount = state.manifest.sessions.length;
      locationCount = state.runtimeLocations.length;
    }
    stage = 'finish_sessions';
    for (const session of state.manifest.sessions) {
      if (!session.cloudAgentSessionId) continue;
      const cloudAgentSessionId = session.cloudAgentSessionId;
      await withDORetry(
        () => getSandboxSessionStub(ctx.env, ctx.userId, cloudAgentSessionId),
        stub => stub.finishWorktreeDeletion(params.worktreeId),
        'finishWorktreeDeletion'
      );
    }
    stage = 'complete_deletion';
    const output = DeleteWorktreeOutput.parse(
      await ctx.env.SESSION_INGEST.completeCloudAgentWorktreeDeletion(params)
    );
    sessionCount = output.deletedSessionIds.length;
    outcome = 'completed';
    return output;
  } catch (error) {
    if (error instanceof TRPCError) {
      outcome =
        error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED' || error.code === 'BAD_REQUEST'
          ? 'rejected'
          : 'failed';
      errorCode = error.code;
      throw error;
    }
    if (error instanceof Error && error.message.includes(WORKTREE_RUNTIME_HISTORY_UNAVAILABLE)) {
      outcome = 'history_unavailable';
      errorCode = 'WORKTREE_RUNTIME_HISTORY_UNAVAILABLE';
      retryable = false;
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Worktree runtime history is unavailable; recovery is required',
        cause: { error: 'WORKTREE_RUNTIME_HISTORY_UNAVAILABLE', retryable: false },
      });
    }
    if (error instanceof Error && error.message.includes('worktree_access_denied')) {
      outcome = 'rejected';
      errorCode = 'FORBIDDEN';
      retryable = false;
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Worktree access denied' });
    }
    outcome = 'pending';
    errorCode = 'WORKTREE_DELETION_PENDING';
    retryable = true;
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Worktree deletion is incomplete; retry the same worktree',
      cause: {
        error: 'WORKTREE_DELETION_PENDING',
        message: 'Worktree deletion is incomplete; retry the same worktree',
        retryable: true,
      },
    });
  } finally {
    logControlDiagnostic(
      'worktree_deletion',
      {
        worktreeId: params.worktreeId,
        phase: 'finished',
        stage,
        result: outcome,
        sessionCount,
        locationCount,
        errorCode,
        retryable,
        durationMs: Date.now() - startedAt,
      },
      outcome === 'completed' || outcome === 'replayed' || outcome === 'rejected' ? 'info' : 'warn'
    );
  }
}

export const deleteWorktree = protectedProcedure
  .input(DeleteWorktreeInput)
  .output(DeleteWorktreeOutput)
  .mutation(({ input, ctx }) => deleteWorktreeResources(input, ctx));

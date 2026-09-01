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
import { worktreeDeleteResultSchema } from '../../shared/sandbox-control-protocol';
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
    let state = cloudAgentWorktreeDeletionStateSchema.parse(
      await ctx.env.SESSION_INGEST.beginCloudAgentWorktreeDeletion(params)
    );
    if (state.completed)
      return {
        success: true,
        deletedSessionIds: state.manifest.sessions.map(session => session.sessionId),
      };
    const runtimeLocations = [...state.runtimeLocations];
    const directory = getWorktreeWorkspacePath(
      params.organizationId,
      ctx.userId,
      params.worktreeId
    );
    const childSessions: NonNullable<RecordCloudAgentWorktreeCleanupParams['childSessions']> = [];
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
    if (runtimeLocations.length === 0) throw new Error(WORKTREE_RUNTIME_HISTORY_UNAVAILABLE);
    state = cloudAgentWorktreeDeletionStateSchema.parse(
      await ctx.env.SESSION_INGEST.recordCloudAgentWorktreeCleanup({
        ...params,
        runtimeLocations,
        directory,
        ...(childSessions.length > 0 ? { childSessions } : {}),
      })
    );
    for (const location of state.runtimeLocations) {
      const result = worktreeDeleteResultSchema.parse(
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
      state = cloudAgentWorktreeDeletionStateSchema.parse(
        await ctx.env.SESSION_INGEST.recordCloudAgentWorktreeCleanup({
          ...params,
          directory,
          sessionIds: result.sessionIds,
        })
      );
    }
    for (const session of state.manifest.sessions) {
      if (!session.cloudAgentSessionId) continue;
      const cloudAgentSessionId = session.cloudAgentSessionId;
      await withDORetry(
        () => getSandboxSessionStub(ctx.env, ctx.userId, cloudAgentSessionId),
        stub => stub.finishWorktreeDeletion(params.worktreeId),
        'finishWorktreeDeletion'
      );
    }
    return DeleteWorktreeOutput.parse(
      await ctx.env.SESSION_INGEST.completeCloudAgentWorktreeDeletion(params)
    );
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (error instanceof Error && error.message.includes(WORKTREE_RUNTIME_HISTORY_UNAVAILABLE)) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Worktree runtime history is unavailable; recovery is required',
        cause: { error: 'WORKTREE_RUNTIME_HISTORY_UNAVAILABLE', retryable: false },
      });
    }
    if (error instanceof Error && error.message.includes('worktree_access_denied')) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Worktree access denied' });
    }
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Worktree deletion is incomplete; retry the same worktree',
      cause: {
        error: 'WORKTREE_DELETION_PENDING',
        message: 'Worktree deletion is incomplete; retry the same worktree',
        retryable: true,
      },
    });
  }
}

export const deleteWorktree = protectedProcedure
  .input(DeleteWorktreeInput)
  .output(DeleteWorktreeOutput)
  .mutation(({ input, ctx }) => deleteWorktreeResources(input, ctx));

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

const ROOT_DELETION_CONCURRENCY = 8;

async function mapDeletionRoots<T, R>(
  items: T[],
  operation: (item: T) => Promise<R>
): Promise<R[]> {
  const output: R[] = [];
  for (let index = 0; index < items.length; index += ROOT_DELETION_CONCURRENCY) {
    const results = await Promise.allSettled(
      items.slice(index, index + ROOT_DELETION_CONCURRENCY).map(operation)
    );
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
      output.push(result.value);
    }
  }
  return output;
}

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
  let stageStartedAt = startedAt;
  const phaseDurations: Record<string, number> = {};
  const setStage = (next: string): void => {
    const now = Date.now();
    const field = `${stage.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}Ms`;
    phaseDurations[field] = (phaseDurations[field] ?? 0) + Math.max(0, now - stageStartedAt);
    stageStartedAt = now;
    stage = next;
  };
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
    setStage('begin_deletion');
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
    const directories = new Set<string>();
    const childSessions: NonNullable<RecordCloudAgentWorktreeCleanupParams['childSessions']> = [];
    setStage('collect_sessions');
    const discoveries = await mapDeletionRoots(state.manifest.sessions, async session => {
      if (!session.cloudAgentSessionId) return null;
      const cloudAgentSessionId = session.cloudAgentSessionId;
      const rawBegin = await withDORetry(
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
      const location = cloudAgentWorktreeLocationSchema.nullable().parse(rawBegin.location);
      const children = z.array(cloudAgentChildSessionLineageSchema).parse(rawBegin.children);
      return { cloudAgentSessionId, location, children, directory: rawBegin.directory };
    });
    for (const discovery of discoveries) {
      if (!discovery) continue;
      const { cloudAgentSessionId, location, children, directory } = discovery;
      if (typeof directory === 'string' && directory.length > 0) {
        directories.add(directory);
      }
      childSessions.push(...children.map(child => ({ ...child, cloudAgentSessionId })));
      if (
        location &&
        !runtimeLocations.some(
          item => item.sandboxId === location.sandboxId && item.provider === location.provider
        )
      ) {
        runtimeLocations.push(location);
      }
    }
    const recordDirectories =
      directories.size > 0
        ? [...directories]
        : [getWorktreeWorkspacePath(params.organizationId, ctx.userId, params.worktreeId)];
    setStage('runtime_history');
    locationCount = runtimeLocations.length;
    if (runtimeLocations.length === 0) throw new Error(WORKTREE_RUNTIME_HISTORY_UNAVAILABLE);
    setStage('record_manifest');
    for (const directory of recordDirectories) {
      state = cloudAgentWorktreeDeletionStateSchema.parse(
        await ctx.env.SESSION_INGEST.recordCloudAgentWorktreeCleanup({
          ...params,
          runtimeLocations,
          directory,
          ...(childSessions.length > 0 ? { childSessions } : {}),
        })
      );
    }
    sessionCount = state.manifest.sessions.length;
    locationCount = state.runtimeLocations.length;
    for (const location of state.runtimeLocations) {
      setStage('runtime_cleanup');
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
      setStage('record_cleanup');
      for (const directory of recordDirectories) {
        state = cloudAgentWorktreeDeletionStateSchema.parse(
          await ctx.env.SESSION_INGEST.recordCloudAgentWorktreeCleanup({
            ...params,
            directory,
            sessionIds: cleanup.sessionIds,
          })
        );
      }
      sessionCount = state.manifest.sessions.length;
      locationCount = state.runtimeLocations.length;
    }
    setStage('finish_sessions');
    await mapDeletionRoots(state.manifest.sessions, async session => {
      if (!session.cloudAgentSessionId) return;
      const cloudAgentSessionId = session.cloudAgentSessionId;
      await withDORetry(
        () => getSandboxSessionStub(ctx.env, ctx.userId, cloudAgentSessionId),
        stub => stub.finishWorktreeDeletion(params.worktreeId),
        'finishWorktreeDeletion'
      );
    });
    setStage('complete_deletion');
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
    setStage(stage);
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
        ...phaseDurations,
      },
      outcome === 'completed' || outcome === 'replayed' || outcome === 'rejected' ? 'info' : 'warn'
    );
  }
}

export const deleteWorktree = protectedProcedure
  .input(DeleteWorktreeInput)
  .output(DeleteWorktreeOutput)
  .mutation(({ input, ctx }) => deleteWorktreeResources(input, ctx));

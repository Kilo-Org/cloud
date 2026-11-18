import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  cloudAgentWorktreeIdSchema,
  cloudAgentWorktreeDeletionStateSchema,
  cloudAgentWorktreeLocationSchema,
  cloudAgentChildSessionLineageSchema,
  sessionIdSchema,
  WORKTREE_UNREGISTERED_CHILD_SESSIONS,
  WORKTREE_CHILD_LINEAGE_CONFLICT,
  WORKTREE_MEMBERSHIP_CHANGED,
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
import type { TRPCContext } from '../../types';
import { protectedProcedure } from '../auth';

const ROOT_DELETION_CONCURRENCY = 8;
const WORKTREE_IDENTITY_CONFLICT = 'worktree_identity_conflict';
const SAFE_ERROR_CLASS = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const KNOWN_DELETION_ERROR_CODES: ReadonlyArray<readonly [string, string]> = [
  [WORKTREE_UNREGISTERED_CHILD_SESSIONS, WORKTREE_UNREGISTERED_CHILD_SESSIONS],
  [WORKTREE_CHILD_LINEAGE_CONFLICT, WORKTREE_CHILD_LINEAGE_CONFLICT],
  [WORKTREE_MEMBERSHIP_CHANGED, WORKTREE_MEMBERSHIP_CHANGED],
  ['worktree_access_denied', 'worktree_access_denied'],
  ['Worktree identity conflict', WORKTREE_IDENTITY_CONFLICT],
  ['worktree_deletion_not_started', 'worktree_deletion_not_started'],
  ['worktree_cleanup_manifest_changed', 'worktree_cleanup_manifest_changed'],
  ['worktree_cleanup_session_conflict', 'worktree_cleanup_session_conflict'],
  ['worktree_deleting', 'worktree_deleting'],
];

/** Bounded, sanitized cause fields. Never forwards a raw error message. */
function safeDeletionError(error: unknown): { errorClass: string; errorCode?: string } {
  const errorClass =
    error instanceof Error && SAFE_ERROR_CLASS.test(error.name) ? error.name : 'UnknownError';
  const message = error instanceof Error ? error.message : '';
  const errorCode = KNOWN_DELETION_ERROR_CODES.find(([needle]) => message.includes(needle))?.[1];
  return { errorClass, ...(errorCode ? { errorCode } : {}) };
}

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

function isHardDeletionError(error: unknown): boolean {
  if (error instanceof TRPCError) return true;
  if (!(error instanceof Error)) return false;
  return (
    error.message.includes(WORKTREE_CHILD_LINEAGE_CONFLICT) ||
    error.message.includes(WORKTREE_UNREGISTERED_CHILD_SESSIONS) ||
    error.message.includes(WORKTREE_MEMBERSHIP_CHANGED) ||
    error.message.includes('worktree_access_denied') ||
    error.message.includes('Worktree identity conflict')
  );
}

export const DeleteWorktreeInput = z
  .object({
    worktreeId: cloudAgentWorktreeIdSchema,
    kilocodeOrganizationId: z.uuid().optional(),
    onlyIfSoleSessionId: sessionIdSchema.optional(),
  })
  .strict();

export const DeleteWorktreeOutput = z
  .object({
    success: z.literal(true),
    deletedSessionIds: z.array(sessionIdSchema),
    cleanup: z.enum(['complete', 'pending']).default('complete'),
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
  let unreachableRootCount = 0;
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
      await ctx.env.SESSION_INGEST.beginCloudAgentWorktreeDeletion({
        ...params,
        ...(input.onlyIfSoleSessionId ? { onlyIfSoleSessionId: input.onlyIfSoleSessionId } : {}),
      })
    );
    sessionCount = state.manifest.sessions.length;
    locationCount = state.runtimeLocations.length;
    if (state.completed) {
      outcome = 'replayed';
      return {
        success: true,
        deletedSessionIds: state.manifest.sessions.map(session => session.sessionId),
        cleanup: 'complete',
      };
    }
    const runtimeLocations = [...state.runtimeLocations];
    const childSessions: NonNullable<RecordCloudAgentWorktreeCleanupParams['childSessions']> = [];
    setStage('collect_sessions');
    const discoveries = await mapDeletionRoots(state.manifest.sessions, async session => {
      if (!session.cloudAgentSessionId) return null;
      const cloudAgentSessionId = session.cloudAgentSessionId;
      try {
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
        return { cloudAgentSessionId, location, children };
      } catch (error) {
        if (isHardDeletionError(error)) throw error;
        unreachableRootCount += 1;
        logControlDiagnostic(
          'worktree_deletion',
          {
            worktreeId: params.worktreeId,
            phase: 'discovery_unavailable',
            cloudAgentSessionId,
            ...safeDeletionError(error),
          },
          'warn'
        );
        return null;
      }
    });
    for (const discovery of discoveries) {
      if (!discovery) continue;
      const { cloudAgentSessionId, location, children } = discovery;
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
    setStage('record_manifest');
    state = cloudAgentWorktreeDeletionStateSchema.parse(
      await ctx.env.SESSION_INGEST.recordCloudAgentWorktreeCleanup({
        ...params,
        runtimeLocations,
        ...(childSessions.length > 0 ? { childSessions } : {}),
      })
    );
    sessionCount = state.manifest.sessions.length;
    locationCount = state.runtimeLocations.length;

    setStage('content_deletion');
    const content = await ctx.env.SESSION_INGEST.deleteCloudAgentWorktreeContent(params);
    sessionCount = content.deletedSessionIds.length;

    let runtimeComplete = state.runtimeLocations.length > 0;
    const completed = new Set(
      (state.manifest.completedRuntimeLocations ?? []).map(
        location => `${location.provider}:${location.sandboxId}`
      )
    );
    for (const location of state.runtimeLocations) {
      if (completed.has(`${location.provider}:${location.sandboxId}`)) continue;
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
      } catch (error) {
        if (isHardDeletionError(error)) throw error;
        runtimeComplete = false;
        logControlDiagnostic(
          'worktree_cleanup_location',
          {
            worktreeId: params.worktreeId,
            sandboxId: location.sandboxId,
            provider: location.provider,
            result: 'pending',
            durationMs: Date.now() - locationStartedAt,
            ...safeDeletionError(error),
          },
          'warn'
        );
        continue;
      }
      logControlDiagnostic('worktree_cleanup_location', {
        worktreeId: params.worktreeId,
        sandboxId: location.sandboxId,
        provider: location.provider,
        result: 'resources_cleaned',
        sessionCount: cleanup.sessionIds.length,
        durationMs: Date.now() - locationStartedAt,
      });
      setStage('record_cleanup');
      try {
        state = cloudAgentWorktreeDeletionStateSchema.parse(
          await ctx.env.SESSION_INGEST.recordCloudAgentWorktreeCleanup({
            ...params,
            sessionIds: cleanup.sessionIds,
            completedRuntimeLocation: location,
          })
        );
      } catch (error) {
        if (isHardDeletionError(error)) throw error;
        logControlDiagnostic(
          'worktree_deletion',
          {
            worktreeId: params.worktreeId,
            phase: 'record_cleanup_pending',
            sandboxId: location.sandboxId,
            provider: location.provider,
            ...safeDeletionError(error),
          },
          'warn'
        );
        outcome = 'pending';
        return {
          success: true,
          deletedSessionIds: content.deletedSessionIds,
          cleanup: 'pending',
        };
      }
      sessionCount = state.manifest.sessions.length;
      locationCount = state.runtimeLocations.length;
      completed.add(`${location.provider}:${location.sandboxId}`);
    }

    if (runtimeComplete) {
      setStage('finish_sessions');
      const finished = await mapDeletionRoots(state.manifest.sessions, async session => {
        if (!session.cloudAgentSessionId) return true;
        const cloudAgentSessionId = session.cloudAgentSessionId;
        try {
          await withDORetry(
            () => getSandboxSessionStub(ctx.env, ctx.userId, cloudAgentSessionId),
            stub => stub.finishWorktreeDeletion(params.worktreeId),
            'finishWorktreeDeletion'
          );
          return true;
        } catch (error) {
          if (isHardDeletionError(error)) throw error;
          logControlDiagnostic(
            'worktree_deletion',
            {
              worktreeId: params.worktreeId,
              phase: 'finish_pending',
              cloudAgentSessionId,
              ...safeDeletionError(error),
            },
            'warn'
          );
          return false;
        }
      });
      runtimeComplete = finished.every(Boolean);
    }

    if (!runtimeComplete) {
      if (state.runtimeLocations.length === 0) {
        logControlDiagnostic(
          'worktree_deletion',
          {
            worktreeId: params.worktreeId,
            phase: 'runtime_history_missing',
            unreachableRootCount,
          },
          'warn'
        );
      }
      outcome = 'pending';
      return {
        success: true,
        deletedSessionIds: content.deletedSessionIds,
        cleanup: 'pending',
      };
    }

    setStage('complete_deletion');
    let output: z.infer<typeof DeleteWorktreeOutput>;
    try {
      output = DeleteWorktreeOutput.parse(
        await ctx.env.SESSION_INGEST.completeCloudAgentWorktreeDeletion(params)
      );
    } catch (error) {
      if (isHardDeletionError(error)) throw error;
      logControlDiagnostic(
        'worktree_deletion',
        {
          worktreeId: params.worktreeId,
          phase: 'complete_pending',
          ...safeDeletionError(error),
        },
        'warn'
      );
      outcome = 'pending';
      return {
        success: true,
        deletedSessionIds: content.deletedSessionIds,
        cleanup: 'pending',
      };
    }
    sessionCount = output.deletedSessionIds.length;
    outcome = 'completed';
    return { ...output, cleanup: 'complete' };
  } catch (error) {
    if (error instanceof TRPCError) {
      outcome =
        error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED' || error.code === 'BAD_REQUEST'
          ? 'rejected'
          : 'failed';
      errorCode = error.code;
      throw error;
    }
    if (error instanceof Error && error.message.includes('worktree_access_denied')) {
      outcome = 'rejected';
      errorCode = 'FORBIDDEN';
      retryable = false;
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Worktree access denied' });
    }
    if (error instanceof Error && error.message.includes(WORKTREE_MEMBERSHIP_CHANGED)) {
      outcome = 'rejected';
      errorCode = 'WORKTREE_MEMBERSHIP_CHANGED';
      retryable = false;
      throw new TRPCError({
        code: 'CONFLICT',
        message: WORKTREE_MEMBERSHIP_CHANGED,
        cause: { error: errorCode, retryable: false },
      });
    }
    if (error instanceof Error && error.message.includes('Worktree identity conflict')) {
      outcome = 'rejected';
      errorCode = 'WORKTREE_IDENTITY_CONFLICT';
      retryable = false;
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: WORKTREE_IDENTITY_CONFLICT,
        cause: { error: errorCode, retryable: false },
      });
    }
    if (error instanceof Error && error.message.includes(WORKTREE_UNREGISTERED_CHILD_SESSIONS)) {
      outcome = 'rejected';
      errorCode = 'WORKTREE_UNREGISTERED_CHILD_SESSIONS';
      retryable = false;
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Worktree has child sessions without registered workspace ownership',
        cause: { error: errorCode, retryable: false },
      });
    }
    if (error instanceof Error && error.message.includes(WORKTREE_CHILD_LINEAGE_CONFLICT)) {
      outcome = 'rejected';
      errorCode = 'WORKTREE_CHILD_LINEAGE_CONFLICT';
      retryable = false;
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Worktree child session ownership or lineage conflicts with persisted state',
        cause: { error: errorCode, retryable: false },
      });
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
        unreachableRootCount,
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

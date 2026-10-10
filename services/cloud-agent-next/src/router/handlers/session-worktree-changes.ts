import { TRPCError } from '@trpc/server';
import { withLogTags } from '../../logger.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { sessionFor } from '../../session-plane.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';
import {
  GetWorktreeChangesOutput,
  GetWorktreeFileOutput,
  RefreshWorktreeChangesOutput,
  WorktreeChangesInput,
  WorktreeFileInput,
} from '../schemas.js';

type ControlPlaneSessionStub = ReturnType<typeof getSandboxSessionStub>;

/**
 * Runs a worktree-changes operation against the control-plane Session DO (with
 * a fresh stub per retry). Worktree changes only exist on the control plane, so
 * a legacy (`agent_*`) session reports the normal precondition error. The plane
 * decision itself lives in `session-plane.ts`.
 */
function worktreeChangesFor<T>(
  env: Parameters<typeof getSandboxSessionStub>[0],
  userId: string,
  sessionId: string,
  operation: (getStub: () => ControlPlaneSessionStub) => Promise<T>
): Promise<T> {
  return sessionFor(
    sessionId,
    () => operation(() => getSandboxSessionStub(env, userId, sessionId)),
    () => {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Worktree changes are not available for this session',
      });
    }
  );
}

export function createSessionWorktreeChangesHandlers() {
  return {
    getWorktreeChanges: protectedProcedure
      .input(WorktreeChangesInput)
      .output(GetWorktreeChangesOutput)
      .query(({ input, ctx }) =>
        withLogTags({ source: 'getWorktreeChanges' }, async () => {
          await requireCurrentSessionAccess({
            env: ctx.env,
            kiloUserId: ctx.userId,
            cloudAgentSessionId: input.cloudAgentSessionId,
          });
          return worktreeChangesFor(ctx.env, ctx.userId, input.cloudAgentSessionId, getStub =>
            withDORetry(getStub, session => session.getWorktreeChanges(), 'getWorktreeChanges')
          );
        })
      ),

    getWorktreeFile: protectedProcedure
      .input(WorktreeFileInput)
      .output(GetWorktreeFileOutput)
      .query(({ input, ctx }) =>
        withLogTags({ source: 'getWorktreeFile' }, async () => {
          await requireCurrentSessionAccess({
            env: ctx.env,
            kiloUserId: ctx.userId,
            cloudAgentSessionId: input.cloudAgentSessionId,
          });
          return worktreeChangesFor(ctx.env, ctx.userId, input.cloudAgentSessionId, getStub =>
            withDORetry(
              getStub,
              async session =>
                await session.getWorktreeFile({
                  path: input.path,
                  expectedRevision: input.expectedRevision,
                }),
              'getWorktreeFile'
            )
          );
        })
      ),

    refreshWorktreeChanges: protectedProcedure
      .input(WorktreeChangesInput)
      .output(RefreshWorktreeChangesOutput)
      .mutation(({ input, ctx }) =>
        withLogTags({ source: 'refreshWorktreeChanges' }, async () => {
          await requireCurrentSessionAccess({
            env: ctx.env,
            kiloUserId: ctx.userId,
            cloudAgentSessionId: input.cloudAgentSessionId,
          });
          return worktreeChangesFor(ctx.env, ctx.userId, input.cloudAgentSessionId, getStub =>
            withDORetry(
              getStub,
              async session => await session.refreshWorktreeChanges(),
              'refreshWorktreeChanges'
            )
          );
        })
      ),
  };
}

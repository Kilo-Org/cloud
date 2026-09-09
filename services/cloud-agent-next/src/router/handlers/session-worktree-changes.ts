import { TRPCError } from '@trpc/server';
import { withLogTags } from '../../logger.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { sessionPlaneFromId } from '../../session-plane.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';
import {
  GetWorktreeChangesOutput,
  GetWorktreeFileOutput,
  RefreshWorktreeChangesOutput,
  WorktreeChangesInput,
  WorktreeFileInput,
} from '../schemas.js';

function requireControlSession(sessionId: string): void {
  if (sessionPlaneFromId(sessionId) !== 'control') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Worktree changes are not available for this session',
    });
  }
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
          requireControlSession(input.cloudAgentSessionId);
          return withDORetry(
            () => getSandboxSessionStub(ctx.env, ctx.userId, input.cloudAgentSessionId),
            session => session.getWorktreeChanges(),
            'getWorktreeChanges'
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
          requireControlSession(input.cloudAgentSessionId);
          return withDORetry(
            () => getSandboxSessionStub(ctx.env, ctx.userId, input.cloudAgentSessionId),
            async session =>
              await session.getWorktreeFile({
                path: input.path,
                expectedRevision: input.expectedRevision,
              }),
            'getWorktreeFile'
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
          requireControlSession(input.cloudAgentSessionId);
          return withDORetry(
            () => getSandboxSessionStub(ctx.env, ctx.userId, input.cloudAgentSessionId),
            async session => await session.refreshWorktreeChanges(),
            'refreshWorktreeChanges'
          );
        })
      ),
  };
}

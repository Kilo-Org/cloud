import { TRPCError } from '@trpc/server';
import { withLogTags } from '../../logger.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import type { TRPCContext } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import type {
  AdoptWorktreeBaseResponse,
  WorktreeBranchOperationInput,
} from '../../session/worktree-branch-operation.js';
import type { WorktreeBranchOperationResult } from '../../shared/worktree-git-operations.js';
import { protectedProcedure } from '../auth.js';
import {
  AdoptWorktreeBaseInput,
  AdoptWorktreeBaseOutput,
  RestackWorktreeBranchInput,
  SyncWorktreeBranchInput,
  WorktreeBranchOperationOutput,
} from '../schemas.js';

/**
 * Sync and Restack are session-addressed mutations. A transport failure may
 * follow a completed force-push, so these handlers never call `withDORetry`
 * and never retry: the caller gets an explicit "outcome unknown" failure.
 */
export function createSessionWorktreeGitHandlers() {
  const run = async (
    ctx: TRPCContext,
    cloudAgentSessionId: string,
    operation: 'sync' | 'restack',
    input: WorktreeBranchOperationInput
  ): Promise<WorktreeBranchOperationResult> => {
    await requireCurrentSessionAccess({
      env: ctx.env,
      kiloUserId: ctx.userId,
      cloudAgentSessionId,
    });
    const stub = getSandboxSessionStub(ctx.env, ctx.userId, cloudAgentSessionId);
    let response;
    try {
      response =
        operation === 'sync'
          ? await stub.syncWorktreeBranch(input)
          : await stub.restackWorktreeBranch(input);
    } catch (error) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: `worktree_operation_outcome_unknown: ${error instanceof Error ? error.message : 'Worktree operation outcome is unknown'}`,
      });
    }
    if (!response.ok) {
      const code =
        response.code === 'not_a_worktree_session'
          ? 'BAD_REQUEST'
          : response.code === 'sandbox_not_ready'
            ? 'SERVICE_UNAVAILABLE'
            : 'INTERNAL_SERVER_ERROR';
      throw new TRPCError({ code, message: `${response.code}: ${response.message}` });
    }
    return response.result;
  };

  return {
    syncWorktreeBranch: protectedProcedure
      .input(SyncWorktreeBranchInput)
      .output(WorktreeBranchOperationOutput)
      .mutation(({ input, ctx }) =>
        withLogTags({ source: 'syncWorktreeBranch' }, () =>
          run(ctx, input.cloudAgentSessionId, 'sync', {
            ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
            ...(input.upstreamSha === undefined ? {} : { upstreamSha: input.upstreamSha }),
          })
        )
      ),

    restackWorktreeBranch: protectedProcedure
      .input(RestackWorktreeBranchInput)
      .output(WorktreeBranchOperationOutput)
      .mutation(({ input, ctx }) =>
        withLogTags({ source: 'restackWorktreeBranch' }, () =>
          run(ctx, input.cloudAgentSessionId, 'restack', {
            ...(input.baseBranch === undefined ? {} : { baseBranch: input.baseBranch }),
            ...(input.upstreamSha === undefined ? {} : { upstreamSha: input.upstreamSha }),
          })
        )
      ),

    /**
     * Metadata-only adoption for a sibling session sharing the worktree. The
     * web fanout calls this for every sibling after a completed operation so a
     * later capture cannot overwrite the shared snapshot with a stale base.
     * Idempotent, so a transport retry is safe.
     */
    adoptWorktreeBase: protectedProcedure
      .input(AdoptWorktreeBaseInput)
      .output(AdoptWorktreeBaseOutput)
      .mutation(({ input, ctx }) =>
        withLogTags({ source: 'adoptWorktreeBase' }, async () => {
          await requireCurrentSessionAccess({
            env: ctx.env,
            kiloUserId: ctx.userId,
            cloudAgentSessionId: input.cloudAgentSessionId,
          });
          const stub = getSandboxSessionStub(ctx.env, ctx.userId, input.cloudAgentSessionId);
          const response = await withDORetry<typeof stub, AdoptWorktreeBaseResponse>(
            () => stub,
            current =>
              current.adoptWorktreeBase({
                expectedWorktreeId: input.expectedWorktreeId,
                baseBranch: input.baseBranch,
                baseSha: input.baseSha,
              }),
            'adoptWorktreeBase'
          );
          if (!response.ok) {
            throw new TRPCError({
              code: response.code === 'worktree_mismatch' ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR',
              message: `${response.code}: ${response.message}`,
            });
          }
          return { success: true as const };
        })
      ),
  };
}

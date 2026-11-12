import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { logger, withLogTags } from '../../logger.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import type { SandboxSessionV2 } from '../../control-plane/session/session-do.js';
import type { SessionId } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';
import { sessionIdSchema } from '../schemas.js';

const WorkspaceSnapshotRecoveryInput = z
  .object({
    sessionId: sessionIdSchema.describe('Cloud-agent session ID'),
  })
  .strict();

const WorkspaceSnapshotRecoveryOutput = z.union([
  z.object({ capturedAt: z.number().int().nonnegative().nullable() }).strict(),
  z.null(),
]);

/**
 * Workspace snapshot recovery for a session's failure state.
 *
 * `getWorkspaceSnapshotRecovery` reports the capture time a "Start fresh"
 * action would discard (null when the workspace has no snapshot descriptor).
 * `removeWorkspaceSnapshot` performs that explicit user action and is the only
 * non-workspace-deletion path that deletes the descriptor.
 */
export function createSessionRecoveryHandlers() {
  return {
    getWorkspaceSnapshotRecovery: protectedProcedure
      .input(WorkspaceSnapshotRecoveryInput)
      .output(WorkspaceSnapshotRecoveryOutput)
      .query(async ({ input, ctx }) => {
        return withLogTags({ source: 'getWorkspaceSnapshotRecovery' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { userId, env } = ctx;
          logger.setTags({ userId, sessionId });
          await requireCurrentSessionAccess({
            env,
            kiloUserId: userId,
            cloudAgentSessionId: sessionId,
            validatedSessionAccess: ctx.validatedSessionAccess,
          });
          const getStub = () => getSandboxSessionStub(env, userId, sessionId);
          try {
            return await withDORetry<
              DurableObjectStub<SandboxSessionV2>,
              { capturedAt: number | null } | null
            >(getStub, stub => stub.getWorkspaceSnapshotRecovery(), 'getWorkspaceSnapshotRecovery');
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger
              .withFields({ error: message })
              .warn('Failed to read workspace snapshot recovery state');
            throw new TRPCError({
              code: 'SERVICE_UNAVAILABLE',
              message: 'Workspace snapshot state is temporarily unavailable',
            });
          }
        });
      }),

    removeWorkspaceSnapshot: protectedProcedure
      .input(WorkspaceSnapshotRecoveryInput)
      .output(z.object({ success: z.literal(true) }))
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'removeWorkspaceSnapshot' }, async () => {
          const sessionId = input.sessionId as SessionId;
          const { userId, env } = ctx;
          logger.setTags({ userId, sessionId });
          logger.info('Removing workspace snapshot on user action');
          await requireCurrentSessionAccess({
            env,
            kiloUserId: userId,
            cloudAgentSessionId: sessionId,
            validatedSessionAccess: ctx.validatedSessionAccess,
          });
          const getStub = () => getSandboxSessionStub(env, userId, sessionId);
          try {
            return await withDORetry<DurableObjectStub<SandboxSessionV2>, { success: true }>(
              getStub,
              stub => stub.removeWorkspaceSnapshot(),
              'removeWorkspaceSnapshot'
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.withFields({ error: message }).error('Failed to remove workspace snapshot');
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'Failed to remove workspace snapshot',
            });
          }
        });
      }),
  };
}

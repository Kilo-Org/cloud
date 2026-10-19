import { TRPCError } from '@trpc/server';
import { withLogTags } from '../../logger.js';
import type { SessionMetadata } from '../../persistence/session-metadata.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { sessionFor } from '../../session-plane.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';
import { GetEgressAuditInput, GetEgressAuditOutput } from '../schemas.js';

export function createSessionEgressAuditHandlers() {
  return {
    getEgressAudit: protectedProcedure
      .input(GetEgressAuditInput)
      .output(GetEgressAuditOutput)
      .query(({ input, ctx }) =>
        withLogTags({ source: 'getEgressAudit' }, async () => {
          const access = await requireCurrentSessionAccess({
            env: ctx.env,
            kiloUserId: ctx.userId,
            cloudAgentSessionId: input.cloudAgentSessionId,
          });

          return sessionFor(
            input.cloudAgentSessionId,
            async () => {
              const metadata = await withDORetry(
                () => getSandboxSessionStub(ctx.env, ctx.userId, input.cloudAgentSessionId),
                async (session): Promise<SessionMetadata | null> => session.getMetadata(),
                'getMetadata'
              );
              if (!metadata) {
                throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
              }
              if (
                metadata.identity.userId !== ctx.userId ||
                metadata.identity.sessionId !== input.cloudAgentSessionId ||
                (metadata.identity.orgId ?? null) !== access.organizationId
              ) {
                throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
              }

              const workspace = metadata.workspace;
              if (workspace?.egressAudit !== true) return { records: [], nextCursor: null };

              const sandboxId = workspace.sandboxId;
              if (!sandboxId) {
                throw new TRPCError({
                  code: 'PRECONDITION_FAILED',
                  message: 'Session has no sandbox audit history',
                });
              }
              if (
                workspace.sandboxProvider !== 'cloudflare-containers' ||
                workspace.sandboxRoute !== undefined ||
                (workspace.sandboxKind !== undefined
                  ? workspace.sandboxKind !== 'isolated'
                  : !sandboxId.startsWith('ses-'))
              ) {
                throw new TRPCError({
                  code: 'PRECONDITION_FAILED',
                  message: 'Egress audit is not available for this sandbox',
                });
              }

              return withDORetry(
                () => ctx.env.SANDBOX_CONTAINERS.getByName(sandboxId),
                sandbox => sandbox.getEgressAudit({ cursor: input.cursor, limit: input.limit }),
                'getEgressAudit'
              );
            },
            () => {
              throw new TRPCError({
                code: 'PRECONDITION_FAILED',
                message: 'Egress audit requires a control-plane session',
              });
            }
          );
        })
      ),
  };
}

import type { SessionMetadata } from '../../persistence/session-metadata.js';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import {
  repositoryAccessChangeSchema,
  repositoryAccessViewSchema,
} from '@kilocode/worker-utils/workspace-repository-access';
import { repositoryAccessProcedure } from '../auth.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { withDORetry } from '../../utils/do-retry.js';
import type { TRPCContext } from '../../types.js';

async function sandboxForRepositoryAccess(ctx: TRPCContext, sessionId: string) {
  const access = await requireCurrentSessionAccess({
    env: ctx.env,
    kiloUserId: ctx.userId,
    cloudAgentSessionId: sessionId,
  });
  const metadata = await withDORetry(
    () => getSandboxSessionStub(ctx.env, ctx.userId, sessionId),
    async (stub): Promise<SessionMetadata | null> => stub.getMetadata(),
    'getMetadata'
  );
  if (
    !metadata ||
    metadata.identity.userId !== ctx.userId ||
    metadata.identity.sessionId !== sessionId ||
    (metadata.identity.orgId ?? null) !== access.organizationId
  )
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Session access denied' });
  const sandboxId = metadata.workspace?.sandboxId;
  if (!sandboxId)
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Repository authorization unavailable',
    });
  return ctx.env.SANDBOX_CONTROL.getByName(sandboxId);
}
export function createRepositoryAccessHandlers() {
  return {
    getRepositoryAccess: repositoryAccessProcedure
      .input(z.object({ sessionId: z.string().min(1) }).strict())
      .output(repositoryAccessViewSchema)
      .query(async ({ input, ctx }) => {
        const sandbox = await sandboxForRepositoryAccess(ctx, input.sessionId);
        return sandbox.getRepositoryAccess({ ownerId: ctx.userId, sessionId: input.sessionId });
      }),
    changeRepositoryAccess: repositoryAccessProcedure
      .input(repositoryAccessChangeSchema)
      .output(z.object({ changed: z.boolean(), current: repositoryAccessViewSchema }))
      .mutation(async ({ input, ctx }) => {
        const sandbox = await sandboxForRepositoryAccess(ctx, input.sessionId);
        try {
          return await sandbox.changeRepositoryAccess({ ...input, ownerId: ctx.userId });
        } catch (error) {
          const reason =
            [
              'repository_limit_reached',
              'repository_access_required',
              'repository_read_only',
              'operation_not_supported',
              'authorization_unavailable',
            ].find(reason => error instanceof Error && error.message.includes(reason)) ??
            'authorization_unavailable';
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: reason });
        }
      }),
  };
}

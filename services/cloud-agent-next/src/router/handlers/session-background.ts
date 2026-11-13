import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { backgroundActivityInventorySchema } from '@kilocode/session-ingest-contracts';
import { protectedProcedure } from '../auth.js';
import { sessionIdSchema } from '../schemas.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { withDORetry } from '../../utils/do-retry.js';
import type { SandboxSessionV2 } from '../../control-plane/session/session-do.js';
import type { ControlPlaneControlResult } from '../../shared/control-plane-protocol.js';

export const getBackgroundActivity = protectedProcedure
  .input(z.object({ cloudAgentSessionId: sessionIdSchema }).strict())
  .output(backgroundActivityInventorySchema)
  .query(async ({ input, ctx }) => {
    await requireCurrentSessionAccess({
      env: ctx.env,
      kiloUserId: ctx.userId,
      cloudAgentSessionId: input.cloudAgentSessionId,
    });
    let result: ControlPlaneControlResult;
    try {
      result = await withDORetry<DurableObjectStub<SandboxSessionV2>, ControlPlaneControlResult>(
        () => getSandboxSessionStub(ctx.env, ctx.userId, input.cloudAgentSessionId),
        stub => stub.kiloRequest({ name: 'session.background' }),
        'getBackgroundActivity'
      );
    } catch {
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Background activity status is temporarily unavailable',
      });
    }
    const inventory = result.ok
      ? backgroundActivityInventorySchema.safeParse(result.result)
      : undefined;
    if (!inventory?.success)
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Background activity status is unavailable',
      });
    return inventory.data;
  });

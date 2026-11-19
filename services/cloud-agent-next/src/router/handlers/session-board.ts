import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { agentBoardSchema } from '@kilocode/session-ingest-contracts';
import { protectedProcedure } from '../auth.js';
import { sessionIdSchema } from '../schemas.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { withDORetry } from '../../utils/do-retry.js';
import type { SandboxSessionV2 } from '../../control-plane/session/session-do.js';
import type { ControlPlaneControlResult } from '../../shared/control-plane-protocol.js';

export const getAgentBoard = protectedProcedure
  .input(z.object({ cloudAgentSessionId: sessionIdSchema }).strict())
  .output(agentBoardSchema.nullable())
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
        stub => stub.kiloRequest({ name: 'session.board' }),
        'getAgentBoard'
      );
    } catch {
      throw new TRPCError({
        code: 'SERVICE_UNAVAILABLE',
        message: 'Agent board is temporarily unavailable',
      });
    }
    // The board lives in the runtime. An offline sandbox cannot be read, and a
    // runtime without a board has none; the client keeps the last board it read.
    if (!result.ok && ['runtime_offline', 'unsupported'].includes(result.error.code)) return null;
    const board = result.ok ? agentBoardSchema.safeParse(result.result) : undefined;
    if (!board?.success)
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Agent board is unavailable' });
    return board.data;
  });

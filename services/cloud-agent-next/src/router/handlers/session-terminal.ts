import { TRPCError } from '@trpc/server';
import { logger, withLogTags } from '../../logger.js';
import type { OperationResult } from '../../persistence/types.js';
import type { CloudAgentSession } from '../../persistence/CloudAgentSession.js';
import type { WrapperPty } from '../../kilo/wrapper-client.js';
import type { SessionId } from '../../types/ids.js';
import { withDORetry } from '../../utils/do-retry.js';
import { protectedProcedure } from '../auth.js';
import {
  CloseTerminalInput,
  CloseTerminalOutput,
  CreateTerminalInput,
  CreateTerminalOutput,
  ResizeTerminalInput,
  ResizeTerminalOutput,
} from '../schemas.js';

function throwTerminalError(result: OperationResult<unknown>): never {
  const message = result.error ?? 'Terminal is unavailable';
  const code =
    message === 'Session not found'
      ? 'NOT_FOUND'
      : message.includes('interactive Cloud Agent')
        ? 'FORBIDDEN'
        : message.includes('workspace is prepared')
          ? 'PRECONDITION_FAILED'
          : 'SERVICE_UNAVAILABLE';

  throw new TRPCError({ code, message });
}

function getSessionStub(
  env: { CLOUD_AGENT_SESSION: DurableObjectNamespace<CloudAgentSession> },
  userId: string,
  sessionId: SessionId
): DurableObjectStub<CloudAgentSession> {
  const doId = env.CLOUD_AGENT_SESSION.idFromName(`${userId}:${sessionId}`);
  return env.CLOUD_AGENT_SESSION.get(doId);
}

export function createSessionTerminalHandlers() {
  return {
    createTerminal: protectedProcedure
      .input(CreateTerminalInput)
      .output(CreateTerminalOutput)
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'createTerminal' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          logger.setTags({ userId: ctx.userId, sessionId });
          logger.withFields({ cols: input.cols, rows: input.rows }).info('Creating terminal');

          const result = await withDORetry<
            DurableObjectStub<CloudAgentSession>,
            OperationResult<{ pty: WrapperPty }>
          >(
            () => getSessionStub(ctx.env, ctx.userId, sessionId),
            stub =>
              stub.createTerminal({
                cols: input.cols,
                rows: input.rows,
              }),
            'createTerminal'
          );

          if (!result.success || !result.data) {
            throwTerminalError(result);
          }

          logger.withFields({ ptyId: result.data.pty.id }).info('Terminal created');
          return { pty: result.data.pty };
        });
      }),

    resizeTerminal: protectedProcedure
      .input(ResizeTerminalInput)
      .output(ResizeTerminalOutput)
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'resizeTerminal' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          logger.setTags({ userId: ctx.userId, sessionId, ptyId: input.ptyId });
          const result = await withDORetry<
            DurableObjectStub<CloudAgentSession>,
            OperationResult<{ pty: WrapperPty }>
          >(
            () => getSessionStub(ctx.env, ctx.userId, sessionId),
            stub =>
              stub.resizeTerminal({
                ptyId: input.ptyId,
                cols: input.cols,
                rows: input.rows,
              }),
            'resizeTerminal'
          );

          if (!result.success || !result.data) {
            throwTerminalError(result);
          }

          return { pty: result.data.pty };
        });
      }),

    closeTerminal: protectedProcedure
      .input(CloseTerminalInput)
      .output(CloseTerminalOutput)
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'closeTerminal' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          logger.setTags({ userId: ctx.userId, sessionId, ptyId: input.ptyId });
          logger.info('Closing terminal');

          const result = await withDORetry<
            DurableObjectStub<CloudAgentSession>,
            OperationResult<{ success: boolean }>
          >(
            () => getSessionStub(ctx.env, ctx.userId, sessionId),
            stub => stub.closeTerminal({ ptyId: input.ptyId }),
            'closeTerminal'
          );

          if (!result.success || !result.data) {
            throwTerminalError(result);
          }

          logger.withFields({ success: result.data.success }).info('Terminal close completed');
          return { success: result.data.success };
        });
      }),
  };
}

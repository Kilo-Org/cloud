import { TRPCError } from '@trpc/server';
import { logger, withLogTags } from '../../logger.js';
import type { SessionId } from '../../types.js';
import { getSandboxSessionStub } from '../../sandbox-session/session-stub.js';
import { requireCurrentSessionAccess } from '../../session-access.js';
import type {
  ControlPlaneExecCommandResult,
  ControlPlaneRequestError,
} from '../../shared/control-plane-protocol.js';
import { protectedProcedure } from '../auth.js';
import { ExecCommandInput, ExecCommandOutput } from '../schemas.js';

const EXEC_NOT_READY = 'The workspace is not ready. Send a message to prepare it, then retry.';
const EXEC_SLEEPING = 'The sandbox is sleeping. Send a message to resume, then retry.';
const EXEC_RUNTIME_DISCONNECTED =
  'The sandbox runtime is not connected. Send a message to resume, then retry.';
const EXEC_MESSAGE_RUNNING =
  'A message is running in this session. Wait for it to finish (waitForMessageResult), then retry.';
const EXEC_UNSUPPORTED =
  'This sandbox runtime does not support execCommand yet. It will be available after the sandbox restarts on a newer runtime.';
const EXEC_BUSY =
  'Too many commands are running in this session. Wait for them to finish, then retry.';
const EXEC_WORKTREE_DELETING = 'The worktree is being deleted.';
const EXEC_OUTCOME_UNKNOWN =
  'The command outcome is unknown because the sandbox connection was lost. Inspect the workspace before retrying.';
const EXEC_CANCELLED =
  'The command was interrupted after it started. Inspect the workspace before retrying.';
const EXEC_ROUTE_MISMATCH =
  'The workspace runtime is not prepared for this session. Send a message to prepare it, then retry.';
const EXEC_FAILED = 'The command could not be started in the sandbox.';
const EXEC_UNAVAILABLE = 'The command could not be completed.';

function throwExecError(error: ControlPlaneRequestError): never {
  switch (error.code) {
    case 'not_found':
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Session not found' });
    case 'not_ready':
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: EXEC_NOT_READY });
    case 'sleeping':
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: EXEC_SLEEPING });
    case 'wrapper_not_connected':
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: EXEC_RUNTIME_DISCONNECTED });
    case 'message_running':
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: EXEC_MESSAGE_RUNNING });
    case 'unsupported':
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: EXEC_UNSUPPORTED });
    case 'busy':
      throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: EXEC_BUSY });
    case 'worktree_deleting':
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: EXEC_WORKTREE_DELETING });
    case 'execution_unknown':
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: EXEC_OUTCOME_UNKNOWN });
    case 'cancelled':
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: EXEC_CANCELLED });
    case 'route_mismatch':
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: EXEC_ROUTE_MISMATCH });
    case 'exec_failed':
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: EXEC_FAILED });
    default:
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: EXEC_UNAVAILABLE });
  }
}

export function createSessionExecHandlers() {
  return {
    execCommand: protectedProcedure
      .input(ExecCommandInput)
      .output(ExecCommandOutput)
      .mutation(async ({ input, ctx }) => {
        return withLogTags({ source: 'execCommand' }, async () => {
          const sessionId = input.cloudAgentSessionId as SessionId;
          const { userId, env } = ctx;
          logger.setTags({ userId, sessionId });
          await requireCurrentSessionAccess({
            env,
            kiloUserId: userId,
            cloudAgentSessionId: sessionId,
          });

          // An exception can happen before or after the DO receives the call,
          // so the outcome is unknown rather than safe to replay.
          let result: ControlPlaneExecCommandResult;
          try {
            result = await getSandboxSessionStub(env, userId, sessionId).execCommand({
              command: input.command,
              timeoutMs: input.timeoutSeconds * 1000,
            });
          } catch {
            throw new TRPCError({
              code: 'SERVICE_UNAVAILABLE',
              message: EXEC_OUTCOME_UNKNOWN,
            });
          }

          if (!result.ok) throwExecError(result.error);
          return result.result;
        });
      }),
  };
}

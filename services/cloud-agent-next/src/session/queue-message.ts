/**
 * Queue a user message on an existing cloud-agent session.
 *
 * Shared by:
 *  - the new `send` handler (full options)
 *  - the new `start` handler (initial message at registration time)
 *  - the legacy `sendMessageV2` proxy (full options)
 *  - the legacy `initiateFromKilocodeSessionV2` proxy (`registered-initial`)
 *
 * Returns an HTTP-friendly shape ready to hand back to tRPC.
 */
import { TRPCError } from '@trpc/server';

import type {
  QueueExecutionTurnCommand,
  QueueSessionMessageRequest,
  QueueSessionMessageResult,
  RetryableResultCode,
} from '../execution/types.js';
import type { SessionId, UserId } from '../types/ids.js';
import type { Env } from '../types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { QueueAckResponse } from '../router/schemas.js';
import { withDORetry } from '../utils/do-retry.js';
import { logger } from '../logger.js';

/** Retryable error codes that should map to 503 Service Unavailable. */
const RETRYABLE_CODES: readonly RetryableResultCode[] = [
  'SANDBOX_CONNECT_FAILED',
  'WORKSPACE_SETUP_FAILED',
  'KILO_SERVER_FAILED',
  'WRAPPER_START_FAILED',
] as const;

function isRetryableCode(code: string): code is RetryableResultCode {
  return RETRYABLE_CODES.includes(code as RetryableResultCode);
}

type NonRetryableCode = Exclude<
  Extract<QueueSessionMessageResult, { success: false }>['code'],
  RetryableResultCode
>;

type TRPCCodeName = ConstructorParameters<typeof TRPCError>[0]['code'];

const PERMANENT_CODE_TO_TRPC: Record<NonRetryableCode, TRPCCodeName> = {
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  PENDING_QUEUE_FULL: 'TOO_MANY_REQUESTS',
  INTERNAL: 'INTERNAL_SERVER_ERROR',
};

function throwQueueSessionMessageError(
  result: Extract<QueueSessionMessageResult, { success: false }>
): never {
  if (isRetryableCode(result.code)) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: result.error,
      cause: {
        error: result.code,
        message: result.error,
        retryable: true,
      },
    });
  }

  const code = PERMANENT_CODE_TO_TRPC[result.code] ?? 'INTERNAL_SERVER_ERROR';
  throw new TRPCError({ code, message: result.error });
}

export type QueueMessageInput = {
  cloudAgentSessionId: string;
} & (
  | {
      kind: 'registered-initial';
    }
  | ({
      kind: 'user-message';
    } & QueueExecutionTurnCommand)
);

export type QueueMessageContext = {
  env: Env;
  userId: string;
  botId?: string;
};

/**
 * Enqueue a user message via `CloudAgentSession.queueSessionMessage`.
 *
 * Throws a TRPCError on failure. Returns the same shape as the legacy
 * QueueAckResponse so callers can hand it back directly.
 */
export async function queueMessage(
  input: QueueMessageInput,
  ctx: QueueMessageContext
): Promise<QueueAckResponse> {
  const sessionId = input.cloudAgentSessionId as SessionId;
  const doKey = `${ctx.userId}:${sessionId}`;
  const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(doKey);

  const startRequest: QueueSessionMessageRequest =
    input.kind === 'registered-initial'
      ? {
          kind: 'registered-initial',
          userId: ctx.userId as UserId,
          botId: ctx.botId,
        }
      : {
          kind: 'user-message',
          userId: ctx.userId as UserId,
          botId: ctx.botId,
          turn: {
            ...input.turn,
            id: input.turn.id ?? undefined,
          },
          agent: input.agent,
          finalization: input.finalization,
        };

  const startResult = await withDORetry<
    DurableObjectStub<CloudAgentSession>,
    QueueSessionMessageResult
  >(
    () => ctx.env.CLOUD_AGENT_SESSION.get(doId),
    stub => stub.queueSessionMessage(startRequest),
    'queueSessionMessage'
  );

  if (!startResult.success) {
    logger
      .withFields({
        sessionId,
        userId: ctx.userId,
        kind: input.kind,
        resultCode: startResult.code,
        retryable: isRetryableCode(startResult.code),
      })
      .warn('Cloud-agent Durable Object rejected message queue request');
    throwQueueSessionMessageError(startResult);
  }

  return {
    cloudAgentSessionId: sessionId,
    status: startResult.status,
    streamUrl: `/stream?cloudAgentSessionId=${sessionId}`,
    messageId: startResult.messageId,
    delivery: startResult.delivery,
    wrapperRunId: startResult.wrapperRunId,
  };
}

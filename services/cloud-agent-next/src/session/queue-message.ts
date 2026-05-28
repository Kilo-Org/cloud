/**
 * Queue a user message on an existing cloud-agent session.
 *
 * Shared by current follow-up admission and the retained legacy follow-up
 * endpoint. Prepared initial replay is isolated in `legacy-prepared-admission`.
 *
 * Returns the explicitly compatibility-projected public acknowledgment shape.
 */
import { TRPCError } from '@trpc/server';

import type {
  QueueExecutionTurnCommand,
  SessionMessageAdmissionResult,
  SubmittedSessionMessageRequest,
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
  Extract<SessionMessageAdmissionResult, { success: false }>['code'],
  RetryableResultCode
>;

type TRPCCodeName = ConstructorParameters<typeof TRPCError>[0]['code'];

const PERMANENT_CODE_TO_TRPC: Record<NonRetryableCode, TRPCCodeName> = {
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  PENDING_QUEUE_FULL: 'TOO_MANY_REQUESTS',
  INTERNAL: 'INTERNAL_SERVER_ERROR',
};

export function throwAdmissionError(
  result: Extract<SessionMessageAdmissionResult, { success: false }>
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
} & QueueExecutionTurnCommand;

export type QueueMessageContext = {
  env: Env;
  userId: string;
  botId?: string;
};

/**
 * Admit a user message via `CloudAgentSession.admitSubmittedMessage`.
 *
 * Throws a TRPCError on failure and projects durable admission into the public
 * compatibility response, including `delivery: 'sent'` for accepted replays.
 */
export function projectAdmissionToPublicAck(
  sessionId: SessionId,
  result: Extract<SessionMessageAdmissionResult, { success: true }>
): QueueAckResponse {
  return {
    cloudAgentSessionId: sessionId,
    status: 'started',
    streamUrl: `/stream?cloudAgentSessionId=${sessionId}`,
    messageId: result.messageId,
    delivery: result.compatibilityDelivery,
  };
}

export async function replayMessageIfAlreadyAdmitted(
  input: QueueMessageInput,
  ctx: QueueMessageContext
): Promise<QueueAckResponse | undefined> {
  const messageId = input.turn.id;
  if (messageId === undefined || messageId === null) return undefined;

  const sessionId = input.cloudAgentSessionId as SessionId;
  const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(`${ctx.userId}:${sessionId}`);
  const alreadyAdmitted = await withDORetry<DurableObjectStub<CloudAgentSession>, boolean>(
    () => ctx.env.CLOUD_AGENT_SESSION.get(doId),
    stub => stub.hasMessageAdmission(messageId),
    'hasMessageAdmission'
  );
  if (!alreadyAdmitted) return undefined;

  return queueMessage(input, ctx);
}

export async function queueMessage(
  input: QueueMessageInput,
  ctx: QueueMessageContext
): Promise<QueueAckResponse> {
  const sessionId = input.cloudAgentSessionId as SessionId;
  const doKey = `${ctx.userId}:${sessionId}`;
  const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(doKey);
  const request: SubmittedSessionMessageRequest = {
    userId: ctx.userId as UserId,
    botId: ctx.botId,
    turn: {
      ...input.turn,
      id: input.turn.id ?? undefined,
    },
    agent: input.agent,
    finalization: input.finalization,
  };

  const result = await withDORetry<
    DurableObjectStub<CloudAgentSession>,
    SessionMessageAdmissionResult
  >(
    () => ctx.env.CLOUD_AGENT_SESSION.get(doId),
    stub => stub.admitSubmittedMessage(request),
    'admitSubmittedMessage'
  );

  if (!result.success) {
    logger
      .withFields({
        sessionId,
        userId: ctx.userId,
        resultCode: result.code,
        retryable: isRetryableCode(result.code),
      })
      .warn('Cloud-agent Durable Object rejected message admission request');
    throwAdmissionError(result);
  }

  return projectAdmissionToPublicAck(sessionId, result);
}

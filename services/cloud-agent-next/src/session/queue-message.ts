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
import type { SessionId } from '../types/ids.js';
import type { Env } from '../types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { QueueAckResponse } from '../router/schemas.js';
import { withDORetry } from '../utils/do-retry.js';
import { resolveSessionStub } from '../sandbox-session/session-stub.js';
import { sessionPlaneFromId } from '../session-plane.js';
import { logger } from '../logger.js';
import { preflightExistingPromptModel } from './model-preflight.js';
import { createMessageId } from './message-id.js';
import {
  createRuntimeAuthorization,
  sealRuntimeAuthorization,
} from '@kilocode/worker-utils/runtime-authorization';
import { resolveSecret } from '../auth.js';
import { fetchSessionMetadata } from '../session-service.js';
import jwt from 'jsonwebtoken';

/** Retryable error codes that should map to 503 Service Unavailable. */
const RETRYABLE_CODES: readonly RetryableResultCode[] = [
  'SANDBOX_CONNECT_FAILED',
  'WORKSPACE_SETUP_FAILED',
  'KILO_SERVER_FAILED',
  'WRAPPER_START_FAILED',
  'WRAPPER_FINALIZING',
] as const;

function isRetryableCode(code: string): code is RetryableResultCode {
  return RETRYABLE_CODES.includes(code as RetryableResultCode);
}

type AdmissionFailureCode = Extract<SessionMessageAdmissionResult, { success: false }>['code'];
type NonTransientExecutionCode = Exclude<AdmissionFailureCode, RetryableResultCode>;

type TRPCCodeName = ConstructorParameters<typeof TRPCError>[0]['code'];

const ADMISSION_CODE_TO_TRPC: Record<NonTransientExecutionCode, TRPCCodeName> = {
  NOT_FOUND: 'NOT_FOUND',
  BAD_REQUEST: 'BAD_REQUEST',
  FORBIDDEN: 'FORBIDDEN',
  MODEL_VALIDATION_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  PAYMENT_REQUIRED: 'PAYMENT_REQUIRED',
  COMPUTE_STOPPING: 'CONFLICT',
  BILLING_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  PENDING_QUEUE_FULL: 'TOO_MANY_REQUESTS',
  INTERNAL: 'INTERNAL_SERVER_ERROR',
};

function isAdmissionFailureRetryable(code: AdmissionFailureCode): boolean {
  return (
    isRetryableCode(code) ||
    code === 'PENDING_QUEUE_FULL' ||
    code === 'INTERNAL' ||
    code === 'COMPUTE_STOPPING' ||
    code === 'BILLING_UNAVAILABLE' ||
    code === 'MODEL_VALIDATION_UNAVAILABLE'
  );
}

export function throwAdmissionError(
  result: Extract<SessionMessageAdmissionResult, { success: false }>
): never {
  const explicitlyRetryable = isAdmissionFailureRetryable(result.code);
  const code = isRetryableCode(result.code)
    ? 'SERVICE_UNAVAILABLE'
    : (ADMISSION_CODE_TO_TRPC[result.code] ?? 'INTERNAL_SERVER_ERROR');
  throw new TRPCError({
    code,
    message: result.error,
    cause: {
      error: result.code,
      message: result.error,
      retryable: explicitlyRetryable,
      ...(result.billingFailure ? { billingFailure: result.billingFailure } : {}),
    },
  });
}

export type QueueMessageInput = {
  cloudAgentSessionId: string;
} & QueueExecutionTurnCommand;

export type QueueMessageContext = {
  env: Env;
  userId: string;
  botId?: string;
  authToken?: string;
};

async function recoverExpiredRuntimeAuthorization(
  input: QueueMessageInput,
  ctx: QueueMessageContext
): Promise<void> {
  if (!ctx.authToken) return;
  const claims = jwt.decode(ctx.authToken);
  if (
    !claims ||
    typeof claims !== 'object' ||
    !('aud' in claims || 'tokenPurpose' in claims || 'credentialExchange' in claims)
  ) {
    return;
  }
  const sessionId = input.cloudAgentSessionId as SessionId;
  const stub = resolveSessionStub(ctx.env, ctx.userId, sessionId);
  const state = await withDORetry(
    () => stub,
    target => target.getRuntimeAuthorizationRecoveryState(),
    'getRuntimeAuthorizationRecoveryState'
  );
  if (state.state !== 'expired' || !state.id) return;
  const expectedOldId = state.id;
  const recoveryId = state.recoveryId ?? crypto.randomUUID();
  const metadata = await fetchSessionMetadata(ctx.env, ctx.userId, input.cloudAgentSessionId);
  if (!metadata || metadata.identity.userId !== ctx.userId) return;
  const secret = await resolveSecret(ctx.env.NEXTAUTH_SECRET);
  if (!secret)
    throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Authentication unavailable' });
  const created = await createRuntimeAuthorization({
    token: ctx.authToken,
    secret,
    connectionString: ctx.env.HYPERDRIVE.connectionString,
    resourceKind: 'cloud-agent-next',
    resourceId: metadata.identity.sessionId,
    ...(metadata.identity.orgId ? { organizationId: metadata.identity.orgId } : {}),
  });
  const runtimeAuthorizationSeal = await sealRuntimeAuthorization(created.authorization, secret);
  const result = await withDORetry(
    () => stub,
    target =>
      target.recoverExpiredRuntimeAuthorization({
        ownerId: ctx.userId,
        expectedOldId,
        recoveryId,
        runtimeAuthorizationSeal,
        runtimeToken: created.token,
      }),
    'recoverExpiredRuntimeAuthorization'
  );
  if (result.status === 'denied') {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Runtime authorization denied' });
  }
  if (result.status === 'busy' || result.status === 'retry') {
    throw new TRPCError({
      code: 'CONFLICT',
      message: 'Runtime authorization recovery is waiting for the session runtime to become idle',
    });
  }
}

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

async function hasMessageAdmission(input: QueueMessageInput, ctx: QueueMessageContext) {
  const messageId = input.turn.id;
  if (messageId === undefined || messageId === null) return false;

  const sessionId = input.cloudAgentSessionId as SessionId;
  return withDORetry<DurableObjectStub<CloudAgentSession>, boolean>(
    () => resolveSessionStub(ctx.env, ctx.userId, sessionId),
    stub => stub.hasMessageAdmission(messageId),
    'hasMessageAdmission'
  );
}

export async function preflightAndAdmitPromptMessage<T>(
  input: QueueMessageInput,
  ctx: QueueMessageContext,
  procedure: string,
  admit: (input: QueueMessageInput, ctx: QueueMessageContext) => Promise<T>
): Promise<T> {
  await recoverExpiredRuntimeAuthorization(input, ctx);
  if (sessionPlaneFromId(input.cloudAgentSessionId) === 'control') return admit(input, ctx);
  if (await hasMessageAdmission(input, ctx)) return admit(input, ctx);

  await preflightExistingPromptModel({
    env: ctx.env,
    userId: ctx.userId,
    cloudAgentSessionId: input.cloudAgentSessionId,
    requestedModel: input.agent?.model,
    procedure,
  });

  return admit(input, ctx);
}

export function preflightAndQueuePromptMessage(
  input: QueueMessageInput,
  ctx: QueueMessageContext,
  procedure: string
): Promise<QueueAckResponse> {
  return preflightAndAdmitPromptMessage(input, ctx, procedure, queueMessage);
}

export async function queueMessage(
  input: QueueMessageInput,
  ctx: QueueMessageContext
): Promise<QueueAckResponse> {
  await recoverExpiredRuntimeAuthorization(input, ctx);
  const sessionId = input.cloudAgentSessionId as SessionId;
  const request: SubmittedSessionMessageRequest = {
    userId: ctx.userId,
    botId: ctx.botId,
    turn: {
      ...input.turn,
      id: input.turn.id ?? createMessageId(),
    },
    agent: input.agent,
    finalization: input.finalization,
  };

  const result = await withDORetry<
    DurableObjectStub<CloudAgentSession>,
    SessionMessageAdmissionResult
  >(
    () => resolveSessionStub(ctx.env, ctx.userId, sessionId),
    stub => stub.admitSubmittedMessage(request),
    'admitSubmittedMessage'
  );

  if (!result.success) {
    logger
      .withFields({
        sessionId,
        userId: ctx.userId,
        resultCode: result.code,
        retryable: isAdmissionFailureRetryable(result.code),
      })
      .warn('Cloud-agent Durable Object rejected message admission request');
    throwAdmissionError(result);
  }

  return projectAdmissionToPublicAck(sessionId, result);
}

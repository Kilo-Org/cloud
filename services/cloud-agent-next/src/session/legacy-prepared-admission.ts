import type { QueueAckResponse } from '../router/schemas.js';
import type { Env } from '../types.js';
import type { SessionId } from '../types/ids.js';
import { withDORetry } from '../utils/do-retry.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import {
  buildControlPlaneMessagePayload,
  ControlPlaneMessageInputError,
} from './control-plane-session-input.js';
import { fetchSessionMetadata } from './metadata.js';
import type {
  ControlPlaneSendResult,
  SandboxSessionV2,
} from '../control-plane/session/session-do.js';
import type { MessageResultRPCResponse } from './message-result.js';
import {
  pendingQueueFullAdmissionFailure,
  projectAdmissionToPublicAck,
  throwAdmissionError,
} from './queue-message.js';
import { assertControlSessionId } from './session-id-guard.js';

export type LegacyPreparedInitialAdmissionInput = {
  cloudAgentSessionId: string;
};

export async function replayLegacyPreparedInitialMessageIfAlreadyAdmitted(
  input: LegacyPreparedInitialAdmissionInput,
  ctx: { env: Env; userId: string; botId?: string }
): Promise<QueueAckResponse | undefined> {
  assertControlSessionId(input.cloudAgentSessionId as SessionId);
  const sessionId = input.cloudAgentSessionId as SessionId;
  const metadata = await fetchSessionMetadata(ctx.env, ctx.userId, sessionId);
  const messageId = metadata?.initialMessage?.id;
  if (!messageId) return undefined;
  const result = await withDORetry<DurableObjectStub<SandboxSessionV2>, MessageResultRPCResponse>(
    () => getSandboxSessionStub(ctx.env, ctx.userId, sessionId),
    stub => stub.getMessageResult(messageId),
    'getMessageResult'
  );
  if (result.type !== 'found') return undefined;
  return projectAdmissionToPublicAck(sessionId, {
    success: true,
    outcome: 'queued',
    compatibilityDelivery: result.result.status === 'running' ? 'sent' : 'queued',
    messageId,
  });
}

export async function admitLegacyPreparedInitialMessage(
  input: LegacyPreparedInitialAdmissionInput,
  ctx: { env: Env; userId: string; botId?: string }
): Promise<QueueAckResponse> {
  assertControlSessionId(input.cloudAgentSessionId as SessionId);
  const sessionId = input.cloudAgentSessionId as SessionId;
  const metadata = await fetchSessionMetadata(ctx.env, ctx.userId, sessionId);
  if (!metadata) {
    throwAdmissionError({ success: false, code: 'NOT_FOUND', error: 'Session not found' });
  }
  const initialMessage = metadata.initialMessage;
  const messageId = initialMessage?.id;
  if (!initialMessage || !messageId) {
    throwAdmissionError({ success: false, code: 'BAD_REQUEST', error: 'No prompt provided' });
  }
  const storedTurn = initialMessage.turn;
  const turn =
    storedTurn ??
    (initialMessage.prompt === undefined
      ? undefined
      : {
          type: 'prompt' as const,
          prompt: initialMessage.prompt,
          attachments: initialMessage.attachments,
        });
  if (!turn) {
    throwAdmissionError({ success: false, code: 'BAD_REQUEST', error: 'No prompt provided' });
  }
  if (!metadata.agent?.mode || !metadata.agent.model) {
    throwAdmissionError({
      success: false,
      code: 'BAD_REQUEST',
      error: 'No model specified and session has no default model',
    });
  }
  let payload;
  try {
    payload = await buildControlPlaneMessagePayload({
      env: ctx.env,
      userId: ctx.userId,
      sessionId,
      metadata,
      turn,
      messageId,
      ...(metadata.finalization === undefined ? {} : { finalization: metadata.finalization }),
    });
  } catch (error) {
    throwAdmissionError({
      success: false,
      code: 'BAD_REQUEST',
      error: error instanceof ControlPlaneMessageInputError ? error.detail : 'No prompt provided',
    });
  }
  const sendResult = await withDORetry<DurableObjectStub<SandboxSessionV2>, ControlPlaneSendResult>(
    () => getSandboxSessionStub(ctx.env, ctx.userId, sessionId),
    stub => stub.send(payload),
    'send'
  );
  if (sendResult.type === 'session-not-found') {
    throwAdmissionError({ success: false, code: 'NOT_FOUND', error: 'Session not found' });
  }
  if (sendResult.type === 'queue-full') {
    throwAdmissionError(pendingQueueFullAdmissionFailure());
  }
  return projectAdmissionToPublicAck(sessionId, {
    success: true,
    outcome: 'queued',
    compatibilityDelivery: 'queued',
    messageId: payload.messageId,
  });
}

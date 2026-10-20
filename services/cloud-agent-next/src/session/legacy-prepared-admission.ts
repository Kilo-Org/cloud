import type {
  LegacyRegisteredInitialAdmissionRequest,
  SessionMessageAdmissionResult,
} from '../execution/types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { QueueAckResponse } from '../router/schemas.js';
import { logger } from '../logger.js';
import { recordCloudAgentSessionFailure } from '../telemetry/session-reports.js';
import type { Env } from '../types.js';
import type { SessionId } from '../types/ids.js';
import { withDORetry } from '../utils/do-retry.js';
import {
  getSandboxSessionStub,
  resolveLegacySessionStub,
} from '../sandbox-session/session-stub.js';
import {
  buildControlPlaneMessagePayload,
  ControlPlaneMessageInputError,
} from './control-plane-session-input.js';
import { fetchSessionMetadata } from '../session-service.js';
import { sessionPlaneFromId } from '../session-plane.js';
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
import { initialAdmissionFailure } from './admission-failure.js';

export type LegacyPreparedInitialAdmissionInput = {
  cloudAgentSessionId: string;
};

export async function replayLegacyPreparedInitialMessageIfAlreadyAdmitted(
  input: LegacyPreparedInitialAdmissionInput,
  ctx: { env: Env; userId: string; botId?: string }
): Promise<QueueAckResponse | undefined> {
  const sessionId = input.cloudAgentSessionId as SessionId;
  if (sessionPlaneFromId(sessionId) === 'control') {
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
  const request: LegacyRegisteredInitialAdmissionRequest = {
    userId: ctx.userId,
    botId: ctx.botId,
  };
  const result = await withDORetry<
    DurableObjectStub<CloudAgentSession>,
    SessionMessageAdmissionResult | undefined
  >(
    () => resolveLegacySessionStub(ctx.env, ctx.userId, sessionId),
    stub => stub.replayPreparedInitialMessage(request),
    'replayPreparedInitialMessage'
  );

  if (!result) return undefined;
  if (!result.success) throwAdmissionError(result);
  return projectAdmissionToPublicAck(sessionId, result);
}

async function recordSetupFailure(record: () => Promise<void>): Promise<void> {
  try {
    await record();
  } catch {
    logger.warn('Failed to record legacy initial admission failure after Durable Object outcome');
  }
}

export async function admitLegacyPreparedInitialMessage(
  input: LegacyPreparedInitialAdmissionInput,
  ctx: { env: Env; userId: string; botId?: string }
): Promise<QueueAckResponse> {
  const sessionId = input.cloudAgentSessionId as SessionId;
  if (sessionPlaneFromId(sessionId) === 'control') {
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
    const sendResult = await withDORetry<
      DurableObjectStub<SandboxSessionV2>,
      ControlPlaneSendResult
    >(
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

  const request: LegacyRegisteredInitialAdmissionRequest = {
    userId: ctx.userId,
    botId: ctx.botId,
  };
  let result: SessionMessageAdmissionResult;
  try {
    result = await withDORetry<DurableObjectStub<CloudAgentSession>, SessionMessageAdmissionResult>(
      () => resolveLegacySessionStub(ctx.env, ctx.userId, sessionId),
      stub => stub.admitPreparedInitialMessage(request),
      'admitPreparedInitialMessage'
    );
  } catch (error) {
    await recordSetupFailure(() =>
      recordCloudAgentSessionFailure(
        {
          cloudAgentSessionId: input.cloudAgentSessionId,
          failure: { stage: 'transport', code: 'do_rpc_outcome_unknown' },
        },
        ctx.env
      )
    );
    throw error;
  }

  if (!result.success) {
    await recordSetupFailure(() =>
      recordCloudAgentSessionFailure(
        {
          cloudAgentSessionId: input.cloudAgentSessionId,
          failure: initialAdmissionFailure(result),
        },
        ctx.env
      )
    );
    throwAdmissionError(result);
  }
  return projectAdmissionToPublicAck(sessionId, result);
}

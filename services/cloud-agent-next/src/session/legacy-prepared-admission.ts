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
import { resolveSessionStub } from '../sandbox-session/session-stub.js';
import { projectAdmissionToPublicAck, throwAdmissionError } from './queue-message.js';
import { initialAdmissionFailure } from './admission-failure.js';

export type LegacyPreparedInitialAdmissionInput = {
  cloudAgentSessionId: string;
};

export async function replayLegacyPreparedInitialMessageIfAlreadyAdmitted(
  input: LegacyPreparedInitialAdmissionInput,
  ctx: { env: Env; userId: string; botId?: string }
): Promise<QueueAckResponse | undefined> {
  const sessionId = input.cloudAgentSessionId as SessionId;
  const request: LegacyRegisteredInitialAdmissionRequest = {
    userId: ctx.userId,
    botId: ctx.botId,
  };
  const result = await withDORetry<
    DurableObjectStub<CloudAgentSession>,
    SessionMessageAdmissionResult | undefined
  >(
    () => resolveSessionStub(ctx.env, ctx.userId, sessionId),
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
  const request: LegacyRegisteredInitialAdmissionRequest = {
    userId: ctx.userId,
    botId: ctx.botId,
  };
  let result: SessionMessageAdmissionResult;
  try {
    result = await withDORetry<DurableObjectStub<CloudAgentSession>, SessionMessageAdmissionResult>(
      () => resolveSessionStub(ctx.env, ctx.userId, sessionId),
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

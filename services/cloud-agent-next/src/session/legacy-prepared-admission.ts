import type {
  LegacyRegisteredInitialAdmissionRequest,
  SessionMessageAdmissionResult,
} from '../execution/types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { QueueAckResponse } from '../router/schemas.js';
import { logger } from '../logger.js';
import { recordCloudAgentSessionFailure } from '../telemetry/session-reports.js';
import type { Env } from '../types.js';
import type { SessionId, UserId } from '../types/ids.js';
import { withDORetry } from '../utils/do-retry.js';
import { projectAdmissionToPublicAck, throwAdmissionError } from './queue-message.js';

export type LegacyPreparedInitialAdmissionInput = {
  cloudAgentSessionId: string;
};

export async function replayLegacyPreparedInitialMessageIfAlreadyAdmitted(
  input: LegacyPreparedInitialAdmissionInput,
  ctx: { env: Env; userId: string; botId?: string }
): Promise<QueueAckResponse | undefined> {
  const sessionId = input.cloudAgentSessionId as SessionId;
  const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(`${ctx.userId}:${sessionId}`);
  const request: LegacyRegisteredInitialAdmissionRequest = {
    userId: ctx.userId as UserId,
    botId: ctx.botId,
  };
  const result = await withDORetry<
    DurableObjectStub<CloudAgentSession>,
    SessionMessageAdmissionResult | undefined
  >(
    () => ctx.env.CLOUD_AGENT_SESSION.get(doId),
    stub => stub.replayPreparedInitialMessage(request),
    'replayPreparedInitialMessage'
  );

  if (!result) return undefined;
  if (!result.success) throwAdmissionError(result);
  return projectAdmissionToPublicAck(sessionId, result);
}

function legacyInitialAdmissionFailure(
  result: Extract<SessionMessageAdmissionResult, { success: false }>
) {
  if (result.code === 'PENDING_QUEUE_FULL') {
    return { stage: 'initial_admission', code: 'initial_queue_full' } as const;
  }
  if (result.code === 'BAD_REQUEST') {
    return { stage: 'initial_admission', code: 'invalid_initial_intent' } as const;
  }
  return { stage: 'initial_admission', code: 'initial_admission_rejected' } as const;
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
  const doId = ctx.env.CLOUD_AGENT_SESSION.idFromName(`${ctx.userId}:${sessionId}`);
  const request: LegacyRegisteredInitialAdmissionRequest = {
    userId: ctx.userId as UserId,
    botId: ctx.botId,
  };
  let result: SessionMessageAdmissionResult;
  try {
    result = await withDORetry<DurableObjectStub<CloudAgentSession>, SessionMessageAdmissionResult>(
      () => ctx.env.CLOUD_AGENT_SESSION.get(doId),
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
          failure: legacyInitialAdmissionFailure(result),
        },
        ctx.env
      )
    );
    throwAdmissionError(result);
  }
  return projectAdmissionToPublicAck(sessionId, result);
}

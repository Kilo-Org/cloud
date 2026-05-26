import type {
  LegacyRegisteredInitialAdmissionRequest,
  SessionMessageAdmissionResult,
} from '../execution/types.js';
import type { CloudAgentSession } from '../persistence/CloudAgentSession.js';
import type { QueueAckResponse } from '../router/schemas.js';
import type { Env } from '../types.js';
import type { SessionId, UserId } from '../types/ids.js';
import { withDORetry } from '../utils/do-retry.js';
import { projectAdmissionToPublicAck, throwAdmissionError } from './queue-message.js';

export type LegacyPreparedInitialAdmissionInput = {
  cloudAgentSessionId: string;
};

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
  const result = await withDORetry<
    DurableObjectStub<CloudAgentSession>,
    SessionMessageAdmissionResult
  >(
    () => ctx.env.CLOUD_AGENT_SESSION.get(doId),
    stub => stub.admitPreparedInitialMessage(request),
    'admitPreparedInitialMessage'
  );

  if (!result.success) throwAdmissionError(result);
  return projectAdmissionToPublicAck(sessionId, result);
}

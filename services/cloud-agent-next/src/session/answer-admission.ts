/**
 * Admission for an answer to a question or permission the session no longer
 * runs. A settled answer becomes a new Cloud Agent turn, so it must pass the
 * same payer balance and model preflight every prompt and command mutation
 * passes before it is queued.
 *
 * The Session DO decides whether the answer reaches a live turn or becomes a
 * continuation, and it owns the pending-interaction set. It therefore returns
 * the continuation intent instead of admitting it; this module runs the
 * preflight on the caller's identity and hands the preflighted intent back for
 * admission, where the DO rebuilds it and refuses if the session moved on.
 */
import type { BalanceOnlyResult } from '../balance-validation.js';
import { fetchOrgIdForSession, validateBalanceOnly } from '../balance-validation.js';
import type { SandboxSessionV2 } from '../control-plane/session/session-do.js';
import { getSandboxSessionStub } from '../sandbox-session/session-stub.js';
import type { Env } from '../types.js';
import { withDORetry } from '../utils/do-retry.js';
import type {
  ControlPlaneAnswerReply,
  ControlPlaneContinuationAdmissionResult,
  ControlPlaneDispatchResult,
} from '../shared/control-plane-protocol.js';
import { preflightAndAdmitPromptMessage, type QueueMessageInput } from './queue-message.js';

/** The payer balance preflight, injectable in tests exactly like the prompt route. */
export type AnswerBalancePreflight = (params: {
  env: Env;
  authToken: string;
  userId: string;
  cloudAgentSessionId: string;
}) => Promise<BalanceOnlyResult>;

export type AnswerAdmissionDeps = {
  validatePromptBalance?: AnswerBalancePreflight;
};

export type AnswerAdmissionOutcome =
  | { outcome: 'sent' }
  /** Nothing waited on this interaction, or the session moved past it. */
  | { outcome: 'not_pending' }
  /** The payer balance refused the new turn; the interaction stays pending. */
  | { outcome: 'balance'; status: 402 | 500; message: string }
  /** The caller holds no verified bearer, so the preflight cannot run. */
  | { outcome: 'unavailable' };

async function defaultValidatePromptBalance(params: {
  env: Env;
  authToken: string;
  userId: string;
  cloudAgentSessionId: string;
}): Promise<BalanceOnlyResult> {
  const orgId = await fetchOrgIdForSession(params.env, params.userId, params.cloudAgentSessionId);
  return validateBalanceOnly(params.authToken, orgId, params.env);
}

/**
 * Answers a question or permission. A live turn takes the answer directly in
 * the DO, with no preflight, because that turn is already paid for. A settled
 * turn admits its continuation only after the balance and model preflight, so a
 * refusal leaves the interaction pending and the user can retry it.
 *
 * A preflight failure thrown by `preflightAndAdmitPromptMessage` propagates as
 * its `TRPCError`, so each caller projects it with the mapper it already uses
 * for prompts.
 */
export async function answerWithAdmission(params: {
  env: Env;
  userId: string;
  authToken?: string;
  cloudAgentSessionId: string;
  reply: ControlPlaneAnswerReply;
  deps?: AnswerAdmissionDeps;
}): Promise<AnswerAdmissionOutcome> {
  const dispatch = await withDORetry<
    DurableObjectStub<SandboxSessionV2>,
    ControlPlaneDispatchResult
  >(
    () => getSandboxSessionStub(params.env, params.userId, params.cloudAgentSessionId),
    stub => stub.answer({ sessionId: params.cloudAgentSessionId, reply: params.reply }),
    'answer'
  );
  if (dispatch === 'sent') return { outcome: 'sent' };
  if (dispatch === 'not_connected') return { outcome: 'not_pending' };
  const authToken = params.authToken;
  if (!authToken) return { outcome: 'unavailable' };

  const balance = await (params.deps?.validatePromptBalance ?? defaultValidatePromptBalance)({
    env: params.env,
    authToken,
    userId: params.userId,
    cloudAgentSessionId: params.cloudAgentSessionId,
  });
  if (!balance.success) {
    return { outcome: 'balance', status: balance.status, message: balance.message };
  }

  const intent = dispatch.intent;
  // A continuation is always a prompt turn by construction; refuse rather than
  // preflight a shape the builder cannot have produced.
  if (intent.turn.type !== 'prompt') return { outcome: 'not_pending' };
  const input: QueueMessageInput = {
    cloudAgentSessionId: params.cloudAgentSessionId,
    turn: { type: 'prompt', prompt: intent.turn.prompt },
    agent: intent.agent,
    ...(intent.finalization === undefined ? {} : { finalization: intent.finalization }),
  };
  const admitted = await preflightAndAdmitPromptMessage(
    input,
    { env: params.env, userId: params.userId, authToken },
    'kilo.answer',
    () =>
      withDORetry<DurableObjectStub<SandboxSessionV2>, ControlPlaneContinuationAdmissionResult>(
        () => getSandboxSessionStub(params.env, params.userId, params.cloudAgentSessionId),
        stub =>
          stub.admitAnswerContinuation({
            sessionId: params.cloudAgentSessionId,
            reply: params.reply,
            intent,
          }),
        'admitAnswerContinuation'
      )
  );
  return admitted === 'sent' ? { outcome: 'sent' } : { outcome: 'not_pending' };
}

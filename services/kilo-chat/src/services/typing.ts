/** Identity-agnostic typing indicators. See services/messages.ts for rationale. */

import { pushEventToHumanMembers } from './event-push';

export type TypingParams = { conversationId: string };

export type TypingResult = { ok: true } | { ok: false; code: 'forbidden'; error: string };

export async function setTypingFor(
  env: Env,
  callerId: string,
  params: TypingParams
): Promise<TypingResult> {
  return pushTypingEvent(env, callerId, params, 'typing');
}

export async function stopTypingFor(
  env: Env,
  callerId: string,
  params: TypingParams
): Promise<TypingResult> {
  return pushTypingEvent(env, callerId, params, 'typing.stop');
}

async function pushTypingEvent(
  env: Env,
  callerId: string,
  params: TypingParams,
  event: 'typing' | 'typing.stop'
): Promise<TypingResult> {
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(params.conversationId));
  const result = await convStub.setTyping(callerId);
  if (!result.ok) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  if (result.memberContext.sandboxId) {
    await pushEventToHumanMembers(
      env,
      params.conversationId,
      result.memberContext.sandboxId,
      result.memberContext.humanMemberIds,
      event,
      { memberId: callerId }
    );
  }

  return { ok: true };
}

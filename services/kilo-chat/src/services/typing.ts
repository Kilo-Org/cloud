/** Identity-agnostic typing indicator. See services/messages.ts for rationale. */

import { getConversationContext, pushEventToHumanMembers } from './event-push';

export type SetTypingParams = { conversationId: string };

export type SetTypingResult = { ok: true } | { ok: false; code: 'forbidden'; error: string };

export async function setTypingFor(
  env: Env,
  callerId: string,
  params: SetTypingParams
): Promise<SetTypingResult> {
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(params.conversationId));
  const result = await convStub.setTyping(callerId);
  if (!result.ok) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  const convContext = await getConversationContext(env, params.conversationId);
  if (convContext?.sandboxId) {
    await pushEventToHumanMembers(
      env,
      params.conversationId,
      convContext.sandboxId,
      convContext.humanMemberIds,
      callerId,
      'typing',
      { memberId: callerId }
    );
  }

  return { ok: true };
}

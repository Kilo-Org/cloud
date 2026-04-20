/** Identity-agnostic reaction operations. See services/messages.ts for rationale. */

import { getConversationContext, pushEventToHumanMembers } from './event-push';

export type AddReactionParams = {
  conversationId: string;
  messageId: string;
  emoji: string;
};

export type AddReactionResult =
  | { ok: true; id: string; added: boolean }
  | { ok: false; code: 'forbidden' | 'internal'; error: string };

export async function addReactionFor(
  env: Env,
  callerId: string,
  params: AddReactionParams
): Promise<AddReactionResult> {
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(params.conversationId));
  if (!(await convStub.isMember(callerId))) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }
  const result = await convStub.addReaction({
    messageId: params.messageId,
    memberId: callerId,
    emoji: params.emoji,
  });
  if (!result.ok) {
    return { ok: false, code: 'internal', error: result.error };
  }

  if (result.added) {
    const convContext = await getConversationContext(env, params.conversationId);
    if (convContext?.sandboxId) {
      await pushEventToHumanMembers(
        env,
        params.conversationId,
        convContext.sandboxId,
        convContext.humanMemberIds,
        undefined, // don't exclude — reactions go to everyone
        'reaction.added',
        { messageId: params.messageId, memberId: callerId, emoji: params.emoji }
      );
    }
  }

  return { ok: true, id: result.id, added: result.added };
}

export type RemoveReactionParams = {
  conversationId: string;
  messageId: string;
  emoji: string;
};

export type RemoveReactionResult =
  | { ok: true }
  | { ok: false; code: 'forbidden' | 'internal'; error: string };

export async function removeReactionFor(
  env: Env,
  callerId: string,
  params: RemoveReactionParams
): Promise<RemoveReactionResult> {
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(params.conversationId));
  if (!(await convStub.isMember(callerId))) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }
  const result = await convStub.removeReaction({
    messageId: params.messageId,
    memberId: callerId,
    emoji: params.emoji,
  });
  if (!result.ok) {
    return { ok: false, code: 'internal', error: result.error };
  }

  const convContext = await getConversationContext(env, params.conversationId);
  if (convContext?.sandboxId) {
    await pushEventToHumanMembers(
      env,
      params.conversationId,
      convContext.sandboxId,
      convContext.humanMemberIds,
      undefined, // don't exclude — reactions go to everyone
      'reaction.removed',
      { messageId: params.messageId, memberId: callerId, emoji: params.emoji }
    );
  }

  return { ok: true };
}

/** Identity-agnostic reaction operations. See services/messages.ts for rationale. */

import { pushEventToHumanMembers } from './event-push';
import type { DeferCtx } from './messages';

export type AddReactionParams = {
  conversationId: string;
  messageId: string;
  emoji: string;
};

export type AddReactionResult =
  | { ok: true; id: string; added: boolean }
  | { ok: false; code: 'forbidden' | 'not_found' | 'internal'; error: string };

export async function addReactionFor(
  env: Env,
  callerId: string,
  params: AddReactionParams,
  ctx: DeferCtx
): Promise<AddReactionResult> {
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(params.conversationId));
  const result = await convStub.addReaction({
    messageId: params.messageId,
    memberId: callerId,
    emoji: params.emoji,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, error: result.error };
  }

  if (result.added) {
    if (result.memberContext.sandboxId) {
      const pushPromise = pushEventToHumanMembers(
        env,
        params.conversationId,
        result.memberContext.sandboxId,
        result.memberContext.humanMemberIds,
        'reaction.added',
        { messageId: params.messageId, memberId: callerId, emoji: params.emoji }
      );
      ctx.waitUntil(pushPromise);
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
  | { ok: false; code: 'forbidden' | 'not_found' | 'internal'; error: string };

export async function removeReactionFor(
  env: Env,
  callerId: string,
  params: RemoveReactionParams,
  ctx: DeferCtx
): Promise<RemoveReactionResult> {
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(params.conversationId));
  const result = await convStub.removeReaction({
    messageId: params.messageId,
    memberId: callerId,
    emoji: params.emoji,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, error: result.error };
  }

  if (result.removed) {
    if (result.memberContext.sandboxId) {
      const pushPromise = pushEventToHumanMembers(
        env,
        params.conversationId,
        result.memberContext.sandboxId,
        result.memberContext.humanMemberIds,
        'reaction.removed',
        { messageId: params.messageId, memberId: callerId, emoji: params.emoji }
      );
      ctx.waitUntil(pushPromise);
    }
  }

  return { ok: true };
}

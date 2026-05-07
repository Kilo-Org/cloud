/** Identity-agnostic typing indicators. See services/messages.ts for rationale. */

import { formatError, withDORetry } from '@kilocode/worker-utils';
import { logger } from '../util/logger';
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
  const result = await pushTypingEvent(env, callerId, params, 'typing.stop');
  if (!result.ok) return result;

  if (callerId.startsWith('bot:')) {
    try {
      await withDORetry(
        () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(params.conversationId)),
        async stub => {
          await stub.notifyLatestBotMessageOnTypingStop(callerId);
        },
        'ConversationDO.notifyLatestBotMessageOnTypingStop'
      );
    } catch (err) {
      logger.error('Failed to process bot typing.stop notification trigger', {
        conversationId: params.conversationId,
        botId: callerId,
        ...formatError(err),
      });
    }
  }

  return result;
}

async function pushTypingEvent(
  env: Env,
  callerId: string,
  params: TypingParams,
  event: 'typing' | 'typing.stop'
): Promise<TypingResult> {
  const result = await withDORetry(
    () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(params.conversationId)),
    async stub => stub.setTyping(callerId),
    'ConversationDO.setTyping'
  );
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

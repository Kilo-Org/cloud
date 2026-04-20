/**
 * Identity-agnostic message operations.
 *
 * Both the public HTTP routes (where callerId is derived from JWT) and the
 * bot RPC methods (where callerId is derived from a trusted service-binding
 * sandboxId) go through these functions. Keeps membership checks, webhook
 * enqueue, and MembershipDO maintenance in one place.
 */

import { deliverToBot } from '../webhook/deliver';
import {
  extractConversationContext,
  getConversationContext,
  pushEventToHumanMembers,
  pushInstanceEvent,
  isUserPresentInConversation,
} from './event-push';

export type ContentBlock = { type: string; [key: string]: unknown };

type DeferCtx = { waitUntil: (p: Promise<unknown>) => void } | undefined;

// ─── createMessage ──────────────────────────────────────────────────────────

export type CreateMessageParams = {
  conversationId: string;
  content: ContentBlock[];
  inReplyToMessageId?: string;
  clientId?: string;
};

export type CreateMessageOk = { ok: true; messageId: string; clientId?: string };
export type CreateMessageErr = {
  ok: false;
  code: 'forbidden' | 'internal';
  error: string;
};
export type CreateMessageResult = CreateMessageOk | CreateMessageErr;

export async function createMessageFor(
  env: Env,
  callerId: string,
  params: CreateMessageParams,
  ctx: DeferCtx
): Promise<CreateMessageResult> {
  const { conversationId, content, inReplyToMessageId, clientId } = params;
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));

  if (!(await convStub.isMember(callerId))) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  const result = await convStub.createMessage({
    senderId: callerId,
    content,
    inReplyToMessageId,
  });
  if (!result.ok) {
    return { ok: false, code: 'internal', error: result.error };
  }

  const { messageId } = result;

  // Deliver webhook to each bot member (other than the sender) via direct RPC.
  const botMembers = await convStub.getBotMembersExcluding(callerId);
  if (botMembers.length > 0) {
    const now = new Date().toISOString();
    const deliverPromise = Promise.all(
      botMembers.map(bot =>
        deliverToBot(env, convStub, {
          targetBotId: bot.id,
          conversationId,
          messageId,
          from: callerId,
          content,
          sentAt: now,
        })
      )
    );
    if (ctx) {
      ctx.waitUntil(deliverPromise);
    }
  }

  // Update lastActivityAt on every member's MembershipDO so their recency
  // sort reflects this new message. Best-effort: the message and webhook are
  // already committed, so a MembershipDO failure must not fail the request.
  const info = await convStub.getInfo();
  if (info) {
    const now = Date.now();
    const results = await Promise.allSettled(
      info.members.map(member => {
        const stub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(member.id));
        return stub.updateLastActivity(conversationId, now);
      })
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        console.error('Failed to update MembershipDO lastActivityAt:', r.reason);
      }
    }

    // Push events to human members (reuse info already fetched above).
    const { humanMemberIds, sandboxId } = extractConversationContext(info.members);
    if (sandboxId) {
      const otherHumans = humanMemberIds.filter(id => id !== callerId);

      // Push message.created on conversation context (include sender for multi-client)
      await pushEventToHumanMembers(
        env,
        conversationId,
        sandboxId,
        humanMemberIds,
        undefined,
        'message.created',
        { messageId, senderId: callerId, content, inReplyToMessageId: inReplyToMessageId ?? null }
      );

      // Implicitly stop typing for human senders (bots manage their own typing lifecycle)
      if (humanMemberIds.includes(callerId)) {
        await pushEventToHumanMembers(
          env,
          conversationId,
          sandboxId,
          humanMemberIds,
          undefined,
          'typing.stop',
          { memberId: callerId }
        );
      }

      // For each non-sender human member: if they're present in the conversation,
      // auto-mark read. Otherwise, push conversation.activity on the instance context.
      await Promise.allSettled(
        otherHumans.map(async userId => {
          const present = await isUserPresentInConversation(env, userId, sandboxId, conversationId);
          if (present) {
            const stub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(userId));
            await stub.markRead(conversationId, now);
          } else {
            await pushInstanceEvent(env, sandboxId, [userId], undefined, 'conversation.activity', {
              conversationId,
              lastActivityAt: now,
            });
          }
        })
      );
    }
  }

  return { ok: true, messageId, clientId };
}

// ─── editMessage ────────────────────────────────────────────────────────────

export type EditMessageParams = {
  conversationId: string;
  messageId: string;
  content: ContentBlock[];
  timestamp: number;
};

export type EditMessageOk = {
  ok: true;
  stale: false;
  messageId: string;
};
export type EditMessageStale = {
  ok: true;
  stale: true;
  messageId: string;
};
export type EditMessageErr = {
  ok: false;
  code: 'forbidden' | 'not_found' | 'internal';
  error: string;
};
export type EditMessageResult = EditMessageOk | EditMessageStale | EditMessageErr;

export async function editMessageFor(
  env: Env,
  callerId: string,
  params: EditMessageParams
): Promise<EditMessageResult> {
  const { conversationId, messageId, content, timestamp } = params;
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));

  if (!(await convStub.isMember(callerId))) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  const result = await convStub.editMessage({
    messageId,
    senderId: callerId,
    content,
    clientTimestamp: timestamp,
  });
  if (!result.ok) {
    if (result.code === 'forbidden') return { ok: false, code: 'forbidden', error: 'Forbidden' };
    if (result.code === 'not_found') return { ok: false, code: 'not_found', error: 'Not found' };
    return { ok: false, code: 'internal', error: result.error };
  }
  if (result.stale) {
    return { ok: true, stale: true, messageId: result.messageId };
  }

  const convContext = await getConversationContext(env, conversationId);
  if (convContext?.sandboxId) {
    await pushEventToHumanMembers(
      env,
      conversationId,
      convContext.sandboxId,
      convContext.humanMemberIds,
      undefined,
      'message.updated',
      { messageId: result.messageId, content, clientUpdatedAt: timestamp }
    );
  }

  return {
    ok: true,
    stale: false,
    messageId: result.messageId,
  };
}

// ─── deleteMessage ──────────────────────────────────────────────────────────

export type DeleteMessageParams = { conversationId: string; messageId: string };

export type DeleteMessageResult =
  | { ok: true }
  | {
      ok: false;
      code: 'forbidden' | 'not_found' | 'internal';
      error: string;
    };

export async function deleteMessageFor(
  env: Env,
  callerId: string,
  params: DeleteMessageParams
): Promise<DeleteMessageResult> {
  const { conversationId, messageId } = params;
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));

  if (!(await convStub.isMember(callerId))) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  const result = await convStub.deleteMessage({ messageId, senderId: callerId });
  if (!result.ok) {
    if (result.code === 'forbidden') return { ok: false, code: 'forbidden', error: 'Forbidden' };
    if (result.code === 'not_found') return { ok: false, code: 'not_found', error: 'Not found' };
    return { ok: false, code: 'internal', error: result.error };
  }

  const convContext = await getConversationContext(env, conversationId);
  if (convContext?.sandboxId) {
    await pushEventToHumanMembers(
      env,
      conversationId,
      convContext.sandboxId,
      convContext.humanMemberIds,
      undefined,
      'message.deleted',
      { messageId }
    );
  }

  return { ok: true };
}

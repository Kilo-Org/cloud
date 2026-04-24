/**
 * Identity-agnostic message operations.
 *
 * Both the public HTTP routes (where callerId is derived from JWT) and the
 * bot RPC methods (where callerId is derived from a trusted service-binding
 * sandboxId) go through these functions. Keeps membership checks, webhook
 * enqueue, and MembershipDO maintenance in one place.
 */

import type { ContentBlock } from '@kilocode/kilo-chat';
import { formatError, withDORetry } from '@kilocode/worker-utils';
import { logger } from '../util/logger';
import { deliverToBot, deliverActionExecutedToBot } from '../webhook/deliver';
import {
  extractConversationContext,
  pushEventToHumanMembers,
  pushInstanceEvent,
} from './event-push';
import type { ConversationInfo } from '../do/conversation-do';

export type DeferCtx = { waitUntil: (p: Promise<unknown>) => void } | undefined;

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

  const result = await convStub.createMessage({
    senderId: callerId,
    content,
    inReplyToMessageId,
  });
  if (!result.ok) {
    if (result.code === 'forbidden')
      return { ok: false, code: 'forbidden' as const, error: 'Forbidden' };
    return { ok: false, code: 'internal' as const, error: result.error };
  }

  const { messageId, info } = result;

  const fanOut = postCommitFanOut(
    env,
    info,
    callerId,
    conversationId,
    messageId,
    content,
    inReplyToMessageId,
    clientId
  );

  if (ctx) {
    ctx.waitUntil(fanOut);
  } else {
    await fanOut;
  }

  return { ok: true, messageId, clientId };
}

async function postCommitFanOut(
  env: Env,
  info: ConversationInfo,
  callerId: string,
  conversationId: string,
  messageId: string,
  content: ContentBlock[],
  inReplyToMessageId: string | undefined,
  clientId: string | undefined
): Promise<void> {
  const { humanMemberIds, sandboxId } = extractConversationContext(info.members);
  const botMembers = info.members.filter(m => m.kind === 'bot' && m.id !== callerId);
  const now = Date.now();

  // ── Block A: Deliver webhook to bot members ──────────────────────────
  const webhookDelivery = async () => {
    if (botMembers.length === 0) return;
    const sentAt = new Date().toISOString();

    let inReplyToBody: string | undefined;
    let inReplyToSender: string | undefined;
    if (inReplyToMessageId) {
      const parent = await withDORetry(
        () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId)),
        stub => stub.getMessage(inReplyToMessageId),
        'ConversationDO.getMessage'
      );
      if (parent && !parent.deleted) {
        inReplyToBody = parent.content
          .filter(
            (b): b is { type: 'text'; text: string } =>
              b.type === 'text' && typeof b.text === 'string'
          )
          .map(b => b.text)
          .join('');
        inReplyToSender = parent.senderId;
      }
    }

    await Promise.all(
      botMembers.map(bot =>
        deliverToBot(
          env,
          {
            targetBotId: bot.id,
            conversationId,
            messageId,
            from: callerId,
            content,
            sentAt,
            ...(inReplyToMessageId !== undefined && { inReplyToMessageId }),
            ...(inReplyToBody !== undefined && { inReplyToBody }),
            ...(inReplyToSender !== undefined && { inReplyToSender }),
          },
          { humanMemberIds, sandboxId }
        )
      )
    );
  };

  // ── Block B: Auto-title unnamed conversations ────────────────────────
  const autoTitle = async () => {
    if (info.title !== null) return;
    const text = content
      .filter(
        (b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string'
      )
      .map(b => b.text)
      .join(' ')
      .replace(/\n/g, ' ')
      .trim();
    if (text.length === 0) return;

    const title = text.length > 80 ? text.slice(0, 77) + '...' : text;
    try {
      await withDORetry(
        () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId)),
        stub => stub.updateTitle(title),
        'ConversationDO.updateTitle'
      );
      await Promise.allSettled(
        info.members.map(member =>
          withDORetry(
            () => env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(member.id)),
            stub => stub.updateConversationTitle(conversationId, title),
            'MembershipDO.updateConversationTitle'
          )
        )
      );
      if (sandboxId) {
        await pushInstanceEvent(env, sandboxId, humanMemberIds, 'conversation.renamed', {
          conversationId,
          title,
        });
      }
    } catch (err) {
      logger.error('Failed to auto-title conversation', formatError(err));
    }
  };

  // ── Block C: Update membership lastActivity ──────────────────────────
  const membershipUpdates = async () => {
    const isSenderHuman = humanMemberIds.includes(callerId);
    const results = await Promise.allSettled(
      info.members.map(member => {
        if (isSenderHuman && member.id === callerId) {
          return withDORetry(
            () => env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(member.id)),
            stub => stub.updateLastActivityAndMarkRead(conversationId, now),
            'MembershipDO.updateLastActivityAndMarkRead'
          );
        }
        return withDORetry(
          () => env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(member.id)),
          stub => stub.updateLastActivity(conversationId, now),
          'MembershipDO.updateLastActivity'
        );
      })
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        logger.error('Failed to update MembershipDO lastActivityAt', formatError(r.reason));
      }
    }
  };

  // ── Block D: Push events + auto-mark-read ────────────────────────────
  const eventPushAndMarkRead = async () => {
    if (!sandboxId) return;

    const deliveryMap = await pushEventToHumanMembers(
      env,
      conversationId,
      sandboxId,
      humanMemberIds,
      'message.created',
      {
        messageId,
        senderId: callerId,
        content,
        inReplyToMessageId: inReplyToMessageId ?? null,
        clientId: clientId ?? null,
      }
    );

    if (humanMemberIds.includes(callerId)) {
      await pushEventToHumanMembers(env, conversationId, sandboxId, humanMemberIds, 'typing.stop', {
        memberId: callerId,
      });
    }

    const otherHumans = humanMemberIds.filter(id => id !== callerId);
    await Promise.allSettled(
      otherHumans.map(async userId => {
        const present = deliveryMap.get(userId) ?? false;
        if (present) {
          await withDORetry(
            () => env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(userId)),
            stub => stub.markRead(conversationId, now),
            'MembershipDO.markRead'
          );
          await pushInstanceEvent(env, sandboxId, humanMemberIds, 'conversation.read', {
            conversationId,
            memberId: userId,
            lastReadAt: now,
          });
        } else {
          await pushInstanceEvent(env, sandboxId, [userId], 'conversation.activity', {
            conversationId,
            lastActivityAt: now,
          });
        }
      })
    );
  };

  // Run all four blocks concurrently. Each handles its own errors.
  await Promise.all([webhookDelivery(), autoTitle(), membershipUpdates(), eventPushAndMarkRead()]);
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
  params: EditMessageParams,
  ctx?: DeferCtx
): Promise<EditMessageResult> {
  const { conversationId, messageId, content, timestamp } = params;
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));

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

  if (result.memberContext.sandboxId) {
    const pushPromise = pushEventToHumanMembers(
      env,
      conversationId,
      result.memberContext.sandboxId,
      result.memberContext.humanMemberIds,
      'message.updated',
      { messageId: result.messageId, content, clientUpdatedAt: timestamp }
    );
    if (ctx) ctx.waitUntil(pushPromise);
    else await pushPromise;
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
  params: DeleteMessageParams,
  ctx?: DeferCtx
): Promise<DeleteMessageResult> {
  const { conversationId, messageId } = params;
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));

  const result = await convStub.deleteMessage({ messageId, senderId: callerId });
  if (!result.ok) {
    if (result.code === 'forbidden') return { ok: false, code: 'forbidden', error: 'Forbidden' };
    if (result.code === 'not_found') return { ok: false, code: 'not_found', error: 'Not found' };
    return { ok: false, code: 'internal', error: result.error };
  }

  if (result.memberContext.sandboxId) {
    const pushPromise = pushEventToHumanMembers(
      env,
      conversationId,
      result.memberContext.sandboxId,
      result.memberContext.humanMemberIds,
      'message.deleted',
      { messageId }
    );
    if (ctx) ctx.waitUntil(pushPromise);
    else await pushPromise;
  }

  return { ok: true };
}

// ─── executeAction ─────────────────────────────────────────────────────────

export type ExecuteActionParams = {
  conversationId: string;
  messageId: string;
  groupId: string;
  value: string;
};

export type ExecuteActionResult =
  | { ok: true }
  | {
      ok: false;
      code: 'forbidden' | 'not_found' | 'already_resolved' | 'invalid_value' | 'internal';
      error: string;
    };

export async function executeActionFor(
  env: Env,
  callerId: string,
  params: ExecuteActionParams,
  ctx: DeferCtx
): Promise<ExecuteActionResult> {
  const { conversationId, messageId, groupId, value } = params;
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));

  const result = await convStub.executeAction({
    messageId,
    memberId: callerId,
    groupId,
    value,
  });

  if (!result.ok) {
    return { ok: false, code: result.code, error: result.error };
  }

  // Fetch conversation info once for both event push and webhook delivery
  const info = await convStub.getInfo();
  if (info) {
    const convContext = extractConversationContext(info.members);
    const fanOut = async () => {
      if (convContext.sandboxId) {
        await pushEventToHumanMembers(
          env,
          conversationId,
          convContext.sandboxId,
          convContext.humanMemberIds,
          'message.updated',
          { messageId, content: result.content, clientUpdatedAt: null }
        );

        // Deliver action.executed webhook only to the bot that authored the
        // message holding the resolved actions block. Other bots in the
        // conversation did not present these buttons and must not see the user's
        // decision.
        const author = info.members.find(m => m.id === result.messageSenderId && m.kind === 'bot');
        if (author) {
          await deliverActionExecutedToBot(env, {
            type: 'action.executed',
            targetBotId: author.id,
            conversationId,
            messageId,
            groupId,
            value,
            executedBy: callerId,
            executedAt: new Date().toISOString(),
          });
        }
      }
    };
    if (ctx) ctx.waitUntil(fanOut());
    else await fanOut();
  }

  return { ok: true };
}

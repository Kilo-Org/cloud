/**
 * Identity-agnostic message operations.
 *
 * Both the public HTTP routes (where callerId is derived from JWT) and the
 * bot RPC methods (where callerId is derived from a trusted service-binding
 * sandboxId) go through these functions. Keeps membership checks, webhook
 * enqueue, and MembershipDO maintenance in one place.
 */

import type { ContentBlock, ExecApprovalDecision } from '@kilocode/kilo-chat';
import { formatError, withDORetry } from '@kilocode/worker-utils';
import { logger } from '../util/logger';
import {
  extractConversationContext,
  pushEventToHumanMembers,
  pushInstanceEvent,
} from './event-push';
import type { ConversationInfo } from '../do/conversation-do';

export type DeferCtx = { waitUntil: (p: Promise<unknown>) => void };

/**
 * Grapheme-aware truncation for auto-titles. `String.prototype.slice` indexes
 * UTF-16 code units, so the naive `text.slice(0, 77) + '...'` can split
 * surrogate pairs and grapheme clusters (emoji with modifiers, flags, ZWJ
 * sequences). We use Intl.Segmenter to count and cut on grapheme boundaries.
 */
function truncateByGrapheme(text: string, maxGraphemes: number): string {
  const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });
  let count = 0;
  let cutIndex = text.length;
  for (const { index } of segmenter.segment(text)) {
    if (count === maxGraphemes - 3) {
      cutIndex = index;
    }
    count++;
    if (count > maxGraphemes) {
      return text.slice(0, cutIndex) + '...';
    }
  }
  return text;
}

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

  ctx.waitUntil(fanOut);

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
  const isSenderHuman = humanMemberIds.includes(callerId);

  // ── Block A: Deliver webhook to bot members ──────────────────────────
  // Webhook delivery is enqueued on the ConversationDO's per-conversation
  // chain so back-to-back sends land on the bot in the same order the DO
  // assigned their ULIDs. The DO returns as soon as the delivery is chained;
  // the actual fetch runs in the DO's own `ctx.waitUntil`.
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
        withDORetry(
          () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId)),
          stub =>
            stub.enqueueMessageWebhook(
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
            ),
          'ConversationDO.enqueueMessageWebhook'
        )
      )
    );
  };

  // Compute an auto-title only when the conversation has none. This is a
  // pure computation; the write lives inside the combined fan-out below.
  const computeAutoTitle = (): string | null => {
    if (info.title !== null) return null;
    const text = content
      .filter(
        (b): b is { type: 'text'; text: string } => b.type === 'text' && typeof b.text === 'string'
      )
      .map(b => b.text)
      .join(' ')
      .replace(/\n/g, ' ')
      .trim();
    if (text.length === 0) return null;
    return truncateByGrapheme(text, 80);
  };
  const autoTitle = computeAutoTitle();

  // Persist the auto-title on the ConversationDO in parallel with fan-out.
  const conversationDoTitleWrite = async () => {
    if (autoTitle === null) return;
    try {
      await withDORetry(
        () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId)),
        stub => stub.updateTitleInternal(autoTitle),
        'ConversationDO.updateTitleInternal'
      );
    } catch (err) {
      logger.error('Failed to auto-title conversation on ConversationDO', formatError(err));
    }
  };

  // ── Block B: Push message.created + typing.stop; returns delivery map ─
  const pushMessageEvents = async (): Promise<Map<string, boolean>> => {
    if (!sandboxId) return new Map();

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

    if (isSenderHuman) {
      await pushEventToHumanMembers(env, conversationId, sandboxId, humanMemberIds, 'typing.stop', {
        memberId: callerId,
      });
    }

    return deliveryMap;
  };

  // Run webhook delivery, ConversationDO title write, and event push in
  // parallel; the MembershipDO fan-out needs the delivery map, so it runs
  // after pushMessageEvents resolves.
  const [, , deliveryMap] = await Promise.all([
    webhookDelivery(),
    conversationDoTitleWrite(),
    pushMessageEvents(),
  ]);

  // ── Block C: Single MembershipDO RPC per member ──────────────────────
  // Combines autoTitle, lastActivityAt, and lastReadAt into one round-trip.
  //
  // Per-member semantics:
  // - title      : autoTitle string for every member when auto-titling applied.
  // - activityAt : always `now`.
  // - markRead   : true when the member's own WS received the event
  //                (sender for human-sent messages, or a human recipient with
  //                an active WS for the delivered message.created event).
  const postCommitUpdates = await Promise.allSettled(
    info.members.map(member => {
      const isSender = isSenderHuman && member.id === callerId;
      const delivered = deliveryMap.get(member.id) === true;
      const markRead = isSender || delivered;
      return withDORetry(
        () => env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(member.id)),
        stub =>
          stub.applyPostCommit({
            conversationId,
            ...(autoTitle !== null && { title: autoTitle }),
            activityAt: now,
            markRead,
          }),
        'MembershipDO.applyPostCommit'
      );
    })
  );
  for (const r of postCommitUpdates) {
    if (r.status === 'rejected') {
      logger.error('Failed to apply MembershipDO post-commit update', formatError(r.reason));
    }
  }

  // ── Block D: Instance-level conversation events ──────────────────────
  if (sandboxId) {
    const instanceEvents: Promise<unknown>[] = [];
    if (autoTitle !== null) {
      instanceEvents.push(
        pushInstanceEvent(env, sandboxId, humanMemberIds, 'conversation.renamed', {
          conversationId,
          title: autoTitle,
        })
      );
    }
    // Every member — including the sender — gets a `conversation.activity`
    // event so their sidebar row's `lastActivityAt` advances across tabs.
    // Independently, anyone who has "read" this message (the sender, who
    // authored it, or a recipient whose WS subscribed to the conversation
    // context and delivered `message.created`) gets a `conversation.read`
    // with their own `memberId`. The client filters `.read` by memberId so
    // Alice's read marker never leaks into Bob's sidebar.
    instanceEvents.push(
      pushInstanceEvent(env, sandboxId, humanMemberIds, 'conversation.activity', {
        conversationId,
        lastActivityAt: now,
      })
    );
    for (const userId of humanMemberIds) {
      const isSender = userId === callerId;
      const present = deliveryMap.get(userId) === true;
      if (!isSender && !present) continue;
      instanceEvents.push(
        pushInstanceEvent(env, sandboxId, humanMemberIds, 'conversation.read', {
          conversationId,
          memberId: userId,
          lastReadAt: now,
        })
      );
    }
    await Promise.allSettled(instanceEvents);
  }
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
  ctx: DeferCtx
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
    ctx.waitUntil(pushPromise);
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
  ctx: DeferCtx
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
    ctx.waitUntil(pushPromise);
  }

  return { ok: true };
}

// ─── executeAction ─────────────────────────────────────────────────────────

export type ExecuteActionParams = {
  conversationId: string;
  messageId: string;
  groupId: string;
  value: ExecApprovalDecision;
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
        // decision. Enqueued on the ConversationDO's chain so it's ordered
        // relative to any message webhooks in the same conversation.
        const author = info.members.find(m => m.id === result.messageSenderId && m.kind === 'bot');
        if (author) {
          await withDORetry(
            () => env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId)),
            stub =>
              stub.enqueueActionExecutedWebhook({
                type: 'action.executed',
                targetBotId: author.id,
                conversationId,
                messageId,
                groupId,
                value,
                executedBy: callerId,
                executedAt: new Date().toISOString(),
              }),
            'ConversationDO.enqueueActionExecutedWebhook'
          );
        }
      }
    };
    ctx.waitUntil(fanOut());
  }

  return { ok: true };
}

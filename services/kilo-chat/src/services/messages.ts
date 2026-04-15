/**
 * Identity-agnostic message operations.
 *
 * Both the public HTTP routes (where callerId is derived from JWT) and the
 * bot RPC methods (where callerId is derived from a trusted service-binding
 * sandboxId) go through these functions. Keeps membership checks, webhook
 * enqueue, and MembershipDO maintenance in one place.
 */

import type { WebhookMessage } from '../webhook/deliver';

export type ContentBlock = { type: string; [key: string]: unknown };

type DeferCtx = { waitUntil: (p: Promise<unknown>) => void } | undefined;

// ─── createMessage ──────────────────────────────────────────────────────────

export type CreateMessageParams = {
  conversationId: string;
  content: ContentBlock[];
  inReplyToMessageId?: string;
};

export type CreateMessageOk = { ok: true; messageId: string; version: number };
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
  const { conversationId, content, inReplyToMessageId } = params;
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

  const { messageId, version } = result;

  // Enqueue webhook per bot member (other than the sender). Best-effort:
  // executionCtx.waitUntil may not be available in every caller (e.g. tests).
  const botMembers = await convStub.getBotMembersExcluding(callerId);
  if (botMembers.length > 0) {
    const now = new Date().toISOString();
    const sendPromise = Promise.all(
      botMembers.map(bot =>
        env.WEBHOOK_QUEUE.send({
          targetBotId: bot.id,
          conversationId,
          messageId,
          from: callerId,
          content,
          sentAt: now,
        } satisfies WebhookMessage)
      )
    );
    if (ctx) {
      ctx.waitUntil(sendPromise);
    }
  }

  // Update lastMessageId on every member's MembershipDO so their recency
  // sort reflects this new message.
  const info = await convStub.getInfo();
  if (info) {
    await Promise.all(
      info.members.map(member => {
        const stub = env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(member.id));
        return stub.updateLastMessageId(conversationId, messageId);
      })
    );
  }

  return { ok: true, messageId, version };
}

// ─── editMessage ────────────────────────────────────────────────────────────

export type EditMessageParams = {
  conversationId: string;
  messageId: string;
  content: ContentBlock[];
  version: number;
};

export type EditMessageOk = {
  ok: true;
  conflict: false;
  messageId: string;
  version: number;
};
export type EditMessageConflict = {
  ok: true;
  conflict: true;
  messageId: string;
  version: number;
};
export type EditMessageErr = {
  ok: false;
  code: 'forbidden' | 'not_found' | 'internal';
  error: string;
};
export type EditMessageResult = EditMessageOk | EditMessageConflict | EditMessageErr;

export async function editMessageFor(
  env: Env,
  callerId: string,
  params: EditMessageParams
): Promise<EditMessageResult> {
  const { conversationId, messageId, content, version } = params;
  const convStub = env.CONVERSATION_DO.get(env.CONVERSATION_DO.idFromName(conversationId));

  if (!(await convStub.isMember(callerId))) {
    return { ok: false, code: 'forbidden', error: 'Forbidden' };
  }

  const result = await convStub.editMessage({
    messageId,
    senderId: callerId,
    content,
    version,
  });
  if (!result.ok) {
    if (result.error.includes('not the owner') || result.error.includes('is not the owner')) {
      return { ok: false, code: 'forbidden', error: 'Forbidden' };
    }
    if (result.error.includes('not found')) {
      return { ok: false, code: 'not_found', error: 'Not found' };
    }
    return { ok: false, code: 'internal', error: result.error };
  }
  if (result.conflict) {
    return {
      ok: true,
      conflict: true,
      messageId: result.messageId,
      version: result.version,
    };
  }
  return {
    ok: true,
    conflict: false,
    messageId: result.messageId,
    version: result.version,
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
    if (result.error.includes('not the owner') || result.error.includes('is not the owner')) {
      return { ok: false, code: 'forbidden', error: 'Forbidden' };
    }
    if (result.error.includes('not found')) {
      return { ok: false, code: 'not_found', error: 'Not found' };
    }
    return { ok: false, code: 'internal', error: result.error };
  }
  return { ok: true };
}

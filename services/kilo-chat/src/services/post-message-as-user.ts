// Internal RPC primitive: post a message into the user-bot conversation
// on behalf of the user, from a trusted service-binding caller.
//
// Used by webhook-agent-ingest for webhook-to-chat delivery (replacing the
// deleted `/api/platform/send-chat-message` route). Designed to also serve
// future flows like onboarding warmup that want to post a first message
// from the user's identity before the user opens the chat UI.

import { logger } from '../util/logger';
import { createMessageFor, type DeferCtx } from './messages';
import { createConversationFor } from './conversations';
import { withDORetry } from '@kilocode/worker-utils';

export type PostMessageAsUserCorrelation = {
  triggerId?: string;
  webhookRequestId?: string;
  reason?: string;
};

export type PostMessageAsUserParams = {
  userId: string;
  sandboxId: string;
  message: string;
  // Origin identifier for diagnostics (e.g. "webhook", "onboarding-warmup").
  // Logged so Axiom can attribute new conversations to a specific source.
  source: string;
  // Default true. Pass false to fail the call if the user has never opened
  // a chat with this bot.
  autoCreateConversation?: boolean;
  correlation?: PostMessageAsUserCorrelation;
};

export type PostMessageAsUserOk = {
  ok: true;
  conversationId: string;
  messageId: string;
  conversationCreated: boolean;
};

export type PostMessageAsUserErr = {
  ok: false;
  code: 'no_conversation' | 'forbidden' | 'internal';
  error: string;
};

export type PostMessageAsUserResult = PostMessageAsUserOk | PostMessageAsUserErr;

export async function postMessageAsUser(
  env: Env,
  ctx: DeferCtx,
  params: PostMessageAsUserParams
): Promise<PostMessageAsUserResult> {
  const { userId, sandboxId, message, source, autoCreateConversation = true, correlation } = params;

  logger.setTags({ sandboxId, callerId: userId });

  const existingConversationId = await findUserBotConversation(env, userId, sandboxId);

  let conversationId: string;
  let conversationCreated = false;
  if (existingConversationId) {
    conversationId = existingConversationId;
  } else if (autoCreateConversation) {
    const created = await createConversationFor(env, userId, { sandboxId });
    if (!created.ok) {
      logger.warn('postMessageAsUser: failed to create conversation', {
        source,
        code: created.code,
        error: created.error,
        ...correlation,
      });
      return { ok: false, code: created.code, error: created.error };
    }
    conversationId = created.conversationId;
    conversationCreated = true;
  } else {
    logger.info('postMessageAsUser: no conversation and auto-create disabled', {
      source,
      ...correlation,
    });
    return {
      ok: false,
      code: 'no_conversation',
      error: 'No conversation between user and bot, and autoCreateConversation is false',
    };
  }

  const result = await createMessageFor(
    env,
    userId,
    {
      conversationId,
      content: [{ type: 'text', text: message }],
    },
    ctx
  );

  if (!result.ok) {
    logger.error('postMessageAsUser: createMessageFor failed', {
      source,
      conversationId,
      conversationCreated,
      code: result.code,
      error: result.error,
      ...correlation,
    });
    return { ok: false, code: result.code, error: result.error };
  }

  logger.info('postMessageAsUser: delivered', {
    source,
    conversationId,
    conversationCreated,
    messageId: result.messageId,
    ...correlation,
  });

  return {
    ok: true,
    conversationId,
    messageId: result.messageId,
    conversationCreated,
  };
}

// Look up the user's existing conversation with the given sandbox's bot.
// Returns the most-recently-active conversation id, or null if the user
// has none. The MembershipDO is keyed on user id; listConversations
// already supports a sandbox filter.
async function findUserBotConversation(
  env: Env,
  userId: string,
  sandboxId: string
): Promise<string | null> {
  const result = await withDORetry(
    () => env.MEMBERSHIP_DO.get(env.MEMBERSHIP_DO.idFromName(userId)),
    stub => stub.listConversations({ sandboxId, limit: 1, cursor: null }),
    'MembershipDO.listConversations'
  );
  return result.conversations[0]?.conversationId ?? null;
}

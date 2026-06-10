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
import { userOwnsSandbox } from './sandbox-ownership';
import { withDORetry } from '@kilocode/worker-utils';
import {
  textBlockSchema,
  type PostMessageAsUserParams,
  type PostMessageAsUserResult,
} from '@kilocode/kilo-chat';

// Re-export the shared RPC contract types so callers within this worker
// can import them from a single place alongside the implementation.
export type {
  PostMessageAsUserCorrelation,
  PostMessageAsUserParams,
  PostMessageAsUserOk,
  PostMessageAsUserErr,
  PostMessageAsUserResult,
} from '@kilocode/kilo-chat';

export async function postMessageAsUser(
  env: Env,
  ctx: DeferCtx,
  params: PostMessageAsUserParams
): Promise<PostMessageAsUserResult> {
  const {
    userId,
    sandboxId,
    message,
    source,
    autoCreateConversation = true,
    forceNewConversation = false,
    correlation,
  } = params;

  logger.setTags({ sandboxId, callerId: userId });

  // Validate the message body up front against the same schema the public
  // createMessage HTTP route enforces. Webhook payloads can be up to 256KB
  // and prompt templates may interpolate them verbatim, so without this
  // check the RPC would persist messages that exceed the chat content
  // limits and bypass the trim/non-empty rules. Failing here also avoids
  // creating a brand-new conversation for an invalid message.
  const validatedTextBlock = textBlockSchema.safeParse({ type: 'text', text: message });
  if (!validatedTextBlock.success) {
    logger.warn('postMessageAsUser: invalid message content', {
      source,
      issues: validatedTextBlock.error.issues,
      ...correlation,
    });
    return {
      ok: false,
      code: 'invalid_request',
      error: 'Message is empty or exceeds the maximum chat message length',
    };
  }

  // Unconditional ownership check. createConversationFor would catch this on
  // the create path, but a stale or cross-user (userId, sandboxId) pair with
  // a pre-existing conversation would otherwise post successfully — the
  // ConversationDO membership check is not equivalent to current sandbox
  // ownership. Run it here so every internal caller gets the same guard.
  const owns = await userOwnsSandbox(env, userId, sandboxId);
  if (!owns) {
    logger.warn('postMessageAsUser: caller does not own sandbox', {
      source,
      ...correlation,
    });
    return {
      ok: false,
      code: 'forbidden',
      error: 'You do not have access to this sandbox',
    };
  }

  // Known concurrency limitation: the find-then-create sequence is not
  // atomic across the user's MembershipDO and the new ConversationDO. If
  // two RPC calls for the same (userId, sandboxId) arrive before any
  // conversation exists, both can observe `existingConversationId === null`
  // and both can call createConversationFor, producing two parallel
  // conversations. Subsequent deliveries route into whichever the
  // listConversations({ limit: 1 }) query returns first, which can flap.
  // The proper fix is to push find-or-claim into the user's MembershipDO
  // (single-threaded execution gives atomicity) and have the caller
  // initialize the ConversationDO with the pre-claimed id. Skipped here
  // because real-world concurrent first-deliveries per (user, bot) are
  // rare: webhook triggers fire serially per trigger, and a user with
  // multiple triggers pointing at the same bot would only race on the very
  // first delivery across all of them.
  // `forceNewConversation` skips the reuse lookup so the call always starts a
  // fresh conversation (the install flow wants a dedicated chat per install).
  const existingConversationId = forceNewConversation
    ? null
    : await findUserBotConversation(env, userId, sandboxId);

  let conversationId: string;
  let conversationCreated = false;
  if (existingConversationId) {
    conversationId = existingConversationId;
  } else if (autoCreateConversation || forceNewConversation) {
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
      content: [validatedTextBlock.data],
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
    if (result.code === 'forbidden') {
      return { ok: false, code: 'forbidden', error: result.error };
    }
    if (result.code === 'invalid' || result.code === 'conflict') {
      return { ok: false, code: 'invalid_request', error: result.error };
    }
    return { ok: false, code: 'internal', error: result.error };
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

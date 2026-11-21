import 'server-only';
import { Message, ThreadImpl, type Message as ChatMessage, type Thread } from 'chat';
import { captureException } from '@sentry/nextjs';
import type { User } from '@kilocode/db';
import {
  consumeLinkAccountContext,
  linkKiloUser,
  loadLinkAccountContext,
  type LinkAccountContext,
  type PlatformIdentity,
} from '@/lib/bot-identity';
import { getPlatformIntegration } from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
import { processLinkedMessage } from '@/lib/bot/run';
import { bot } from '@/lib/bot';

export type CompleteLinkAccountOutcome =
  | { status: 'linked'; context: LinkAccountContext }
  | { status: 'used' }
  | { status: 'conflict' }
  | { status: 'context_missing' };

/**
 * Write the chat-platform identity → Kilo user mapping for a link whose caller
 * has already proven control of that platform identity, then hand the stored
 * message back to the agent.
 *
 * Order matters:
 *  1. load the pending context, so an expired link writes nothing;
 *  2. consume it, so a link completes at most once even under concurrent
 *     submissions;
 *  3. compare-and-set the mapping, so an identity already held by a different
 *     Kilo account is never reassigned.
 *
 * Callers must complete the platform's identity proof before calling this; the
 * `identity` argument is what the proof returned, not what a URL claimed.
 */
export async function completeLinkAccount({
  identity,
  contextKey,
  user,
}: {
  identity: PlatformIdentity;
  contextKey: string;
  user: User;
}): Promise<CompleteLinkAccountOutcome> {
  const state = bot.getState();
  const context = await loadLinkAccountContext(state, contextKey);
  if (!context) {
    return { status: 'context_missing' };
  }

  if (!(await consumeLinkAccountContext(state, contextKey))) {
    return { status: 'used' };
  }

  if ((await linkKiloUser(state, identity, user.id)) === 'conflict') {
    return { status: 'conflict' };
  }

  return { status: 'linked', context };
}

/**
 * Replay the chat message that asked for the link now that the mapping exists,
 * so the user does not have to repeat their request. Takes the stored context
 * straight from `completeLinkAccount`.
 */
export async function reprocessLinkedContext(
  identity: PlatformIdentity,
  context: LinkAccountContext,
  user: User
): Promise<void> {
  await reprocessLinkedMessage(
    identity,
    ThreadImpl.fromJSON(context.thread),
    Message.fromJSON(context.message),
    user
  );
}

async function reprocessLinkedMessage(
  identity: PlatformIdentity,
  thread: Thread,
  message: ChatMessage,
  user: User
): Promise<void> {
  try {
    const platformIntegration = await getPlatformIntegration(identity);
    if (!platformIntegration) return;

    await botPlatforms.require(platformIntegration.platform).withAuthContext({
      platformIntegration,
      fn: async () => {
        await processLinkedMessage({
          thread,
          message,
          platformIntegration,
          user,
        });
      },
    });
  } catch (error) {
    console.error('[Bot] Failed to reprocess linked message:', error);
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'link-account-reprocess-message' },
      extra: {
        threadId: thread.id,
        messageId: message.id,
        userId: user.id,
      },
    });
  }
}

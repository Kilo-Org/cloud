import 'server-only';
import {
  Message,
  ThreadImpl,
  type Message as ChatMessage,
  type StateAdapter,
  type Thread,
} from 'chat';
import { captureException } from '@sentry/nextjs';
import type { User } from '@kilocode/db';
import {
  consumeLinkAccountContext,
  isLinkAccountContextConsumed,
  linkKiloUser,
  loadLinkAccountContext,
  releaseLinkAccountContextConsumption,
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
 *  1. read the pending context, so an expired link writes nothing;
 *  2. refuse a link that is already spent, without writing anything;
 *  3. take the single-use claim, which one submission of a pending link holds
 *     and which therefore decides the single writer and the single replayer of
 *     the stored message;
 *  4. write the mapping compare-and-set, giving the claim back when the write is
 *     refused or fails.
 *
 * A held identity is refused without touching the mapping, and a pending link
 * is given back whenever nothing was written, so it stays completable until its
 * TTL. The mapping compare-and-set never reassigns an identity, so a link cannot
 * take over an account it does not belong to.
 *
 * A completion interrupted between the claim and the mapping write leaves the
 * pending link spent with no mapping, so the user starts a new link from the
 * chat. That trade keeps one message from being replayed twice: two runs and
 * two replies cost more than asking for a new link.
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

  if (await isLinkAccountContextConsumed(state, contextKey)) {
    return { status: 'used' };
  }

  // The claim decides who may write the mapping and replay the message, so it
  // is taken first: one submission of a pending link owns both, and every other
  // submission reports the link as used because it wrote nothing.
  if (!(await consumeLinkAccountContext(state, contextKey))) {
    return { status: 'used' };
  }

  try {
    if ((await linkKiloUser(state, identity, user.id)) === 'conflict') {
      // The mapping was refused, so the pending link is given back and stays
      // usable until its TTL.
      await releaseClaim(state, contextKey);
      return { status: 'conflict' };
    }
  } catch (error) {
    // The mapping was not written, so the pending link is given back and the
    // failure reaches the caller's own error page.
    await releaseClaim(state, contextKey);
    throw error;
  }

  return { status: 'linked', context };
}

/**
 * Give a claim back after a mapping write that wrote nothing. The pending link
 * then stays completable until its TTL; a release that fails is recorded and
 * leaves the link reported as used.
 */
async function releaseClaim(state: StateAdapter, contextKey: string): Promise<void> {
  try {
    await releaseLinkAccountContextConsumption(state, contextKey);
  } catch (error) {
    captureException(error, {
      tags: { component: 'kilo-bot', op: 'link-account-claim-release' },
    });
  }
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

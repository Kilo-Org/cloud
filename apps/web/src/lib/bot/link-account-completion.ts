import 'server-only';
import { Message, ThreadImpl, type Message as ChatMessage, type Thread } from 'chat';
import { captureException } from '@sentry/nextjs';
import type { User } from '@kilocode/db';
import {
  consumeLinkAccountContext,
  isLinkAccountContextConsumed,
  linkKiloUser,
  loadLinkAccountContext,
  resolveKiloUserId,
  type LinkAccountContext,
  type PlatformIdentity,
} from '@/lib/bot-identity';
import { getPlatformIntegration } from '@/lib/bot/platform-helpers';
import { botPlatforms } from '@/lib/bot/platforms';
import { processLinkedMessage } from '@/lib/bot/run';
import { bot } from '@/lib/bot';

export type CompleteLinkAccountOutcome =
  | { status: 'linked'; context: LinkAccountContext }
  /**
   * The identity mapping is this Kilo account's, but another submission of the
   * same pending link holds the single-use claim and owns replaying the stored
   * message. This outcome carries no context: the claim winner is the only
   * caller that may replay it.
   */
  | { status: 'linked_elsewhere' }
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
 *  2. refuse a link that is already spent, without writing anything;
 *  3. claim the mapping compare-and-set, so an identity already held by a
 *     different Kilo account is refused while the pending link is still
 *     unspent, and so a transient state-store failure leaves the link usable;
 *  4. consume the pending link, so it completes at most once even under
 *     concurrent submissions.
 *
 * The mapping write is committed before step 4, and it is idempotent per Kilo
 * account, so the link belongs to this account from that point on. Whoever
 * takes the single-use claim in step 4 — this submission or a concurrent one —
 * owns replaying the stored message; the others report `linked_elsewhere`
 * without a context, so exactly one caller hands the message back.
 *
 * A `conflict` therefore leaves the pending link unspent until its TTL. That is
 * safe: the link is bound to the submitting Kilo account and to the chat
 * identity the sign-in proves, a retry for the same pair is refused again, and
 * the mapping compare-and-set never reassigns an identity, so the link cannot
 * take over an account it does not belong to.
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

  if ((await linkKiloUser(state, identity, user.id)) === 'conflict') {
    return { status: 'conflict' };
  }

  let claimed = false;
  try {
    claimed = await consumeLinkAccountContext(state, contextKey);
  } catch (error) {
    // The mapping is committed; report the link as this account's instead of a
    // failure, and leave the pending link unspent so a retry can take the claim.
    captureException(error, { tags: { component: 'kilo-bot', op: 'link-account-claim' } });
  }

  if (claimed) {
    return { status: 'linked', context };
  }

  // A concurrent submission, or the claim above failing, leaves the message
  // replay to whichever submission holds the claim.
  return (await resolveKiloUserId(state, identity)) === user.id
    ? { status: 'linked_elsewhere' }
    : { status: 'used' };
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

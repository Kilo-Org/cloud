import { Chat, emoji, type ActionEvent, type Message, type Thread } from 'chat';
import { createSlackAdapter } from '@chat-adapter/slack';
import { createRedisState } from '@chat-adapter/state-redis';
import { createMemoryState } from '@chat-adapter/state-memory';
import { captureException } from '@sentry/nextjs';
import { resolveKiloUserId, unlinkKiloUser } from '@/lib/bot-identity';
import { getPlatformIdentity, getPlatformIntegration } from '@/lib/bot/platform-helpers';
import { LINK_ACCOUNT_ACTION_PREFIX, promptLinkAccount } from '@/lib/bot/link-account';
import { createBotRequest, updateBotRequest } from '@/lib/bot/request-logging';
import { findUserById } from '@/lib/user';
import { processMessage } from '@/lib/bot/run';

const slackAdapter = createSlackAdapter({
  clientId: process.env.SLACK_NEXT_CLIENT_ID,
  clientSecret: process.env.SLACK_NEXT_CLIENT_SECRET,
  signingSecret: process.env.SLACK_NEXT_SIGNING_SECRET,
});

export const bot = new Chat({
  // TODO(remon): Update names before going live
  userName: process.env.NODE_ENV === 'production' ? 'Pound' : 'Sjors Bot',
  adapters: {
    slack: slackAdapter,
  },
  state: process.env.REDIS_URL ? createRedisState() : createMemoryState(),
});

bot.onNewMention(async function handleIncomingMessage(
  thread: Thread,
  message: Message
): Promise<void> {
  const identity = getPlatformIdentity(thread, message);
  const [platformIntegration, kiloUserId] = await Promise.all([
    getPlatformIntegration(thread, message),
    resolveKiloUserId(bot.getState(), identity),
  ]);

  if (!platformIntegration) {
    captureException(new Error('No active platform integration found'), {
      extra: { platform: identity.platform, teamId: identity.teamId },
    });
    return;
  }

  if (!kiloUserId) {
    await promptLinkAccount(thread, message, identity);
    return;
  }

  const user = await findUserById(kiloUserId);

  if (!user) {
    await unlinkKiloUser(bot.getState(), identity);
    await promptLinkAccount(thread, message, identity);
    return;
  }

  const platform = thread.id.split(':')[0];
  const botRequestId = await createBotRequest({
    createdBy: user.id,
    organizationId: platformIntegration.owned_by_organization_id ?? null,
    platformIntegrationId: platformIntegration.id,
    platform,
    platformThreadId: thread.id,
    platformMessageId: message.id,
    userMessage: message.text,
    modelUsed: undefined,
  });

  const received = thread.createSentMessageFromMessage(message);
  await received.addReaction(emoji.eyes);

  await bot.registerSingleton();

  try {
    await processMessage({ thread, message, platformIntegration, user, botRequestId });
  } catch (error) {
    console.error('[Bot] Unhandled error in message handler:', error);
    if (botRequestId) {
      const errMsg = error instanceof Error ? error.message : String(error);
      updateBotRequest(botRequestId, {
        status: 'error',
        errorMessage: errMsg.slice(0, 2000),
      });
    }
    await thread.post({ markdown: 'Sorry, something went wrong while processing your message.' });
  }
});

// When the user clicks the "Link Account" LinkButton, Slack fires a
// block_actions event *in addition to* opening the URL in the browser.
// For ephemeral messages the adapter encodes the response_url into the
// messageId, so deleteMessage sends `{ delete_original: true }` — removing
// the ephemeral card from the user's view.
bot.onAction(async function handleLinkAccountClick(event: ActionEvent): Promise<void> {
  if (!event.actionId.startsWith(LINK_ACCOUNT_ACTION_PREFIX)) return;

  try {
    await event.adapter.deleteMessage(event.threadId, event.messageId);
  } catch (error) {
    // Not critical — the ephemeral message will disappear on its own eventually
    console.warn('[Bot] Failed to delete link-account ephemeral:', error);
  }
});

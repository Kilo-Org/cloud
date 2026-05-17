import { Chat, type Message, type Thread } from 'chat';
import type { GitHubAdapter } from '@chat-adapter/github';
import type { LinearAdapter } from '@chat-adapter/linear';
import type { SlackAdapter } from '@chat-adapter/slack';
import { captureException } from '@sentry/nextjs';
import { resolveKiloUserId, unlinkKiloUser } from '@/lib/bot-identity';
import {
  canKiloUserAccessPlatformIntegration,
  getPlatformIntegration,
} from '@/lib/bot/platform-helpers';
import { findUserById } from '@/lib/user';
import { processLinkedMessage } from '@/lib/bot/run';
import { createChatState } from '@/lib/bot/state';
import { githubAdapter } from '@/lib/bot/github-adapter';
import { linearAdapter } from '@/lib/bot/linear-adapter';
import { slackAdapter } from '@/lib/bot/slack-adapter';
import { botPlatforms } from '@/lib/bot/platforms';
import { createLinearWebhookHandler } from '@/lib/bot/platforms/linear-webhook';
import { createSlackWebhookHandler } from '@/lib/bot/platforms/slack-webhook';

function createKiloBot(
  slackAdapter: SlackAdapter,
  githubAdapter: GitHubAdapter,
  linearAdapter: LinearAdapter
) {
  const chatBot = new Chat({
    userName: process.env.NODE_ENV === 'production' ? 'Kilo' : 'Henk',
    adapters: {
      github: githubAdapter,
      slack: slackAdapter,
      linear: linearAdapter,
    },
    state: createChatState(),
    logger: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  });

  chatBot.webhooks.slack = createSlackWebhookHandler(chatBot, slackAdapter);
  chatBot.webhooks.linear = createLinearWebhookHandler(chatBot, linearAdapter);

  chatBot.onNewMention(async function handleIncomingMessage(
    thread: Thread,
    message: Message
  ): Promise<void> {
    const botPlatform = botPlatforms.requireByAdapter(thread.adapter);
    const identity = await botPlatform.getIdentity({ thread, message });
    const [platformIntegration, kiloUserId] = await Promise.all([
      getPlatformIntegration(identity),
      resolveKiloUserId(chatBot.getState(), identity),
    ]);

    if (!platformIntegration) {
      captureException(new Error('No active platform integration found'), {
        extra: { platform: identity.platform, teamId: identity.teamId },
      });
      return;
    }

    if (!botPlatform.isEnabledForBot(platformIntegration)) {
      return;
    }

    if (!(await botPlatform.canHandleMessage({ thread, message, platformIntegration }))) {
      return;
    }

    if (!kiloUserId) {
      await botPlatform.promptLinkAccount({
        thread,
        message,
        identity,
        platformIntegration,
        state: chatBot.getState(),
      });
      return;
    }

    const user = await findUserById(kiloUserId);

    if (!user) {
      await unlinkKiloUser(chatBot.getState(), identity);
      await botPlatform.promptLinkAccount({
        thread,
        message,
        identity,
        platformIntegration,
        state: chatBot.getState(),
      });
      return;
    }

    if (!(await canKiloUserAccessPlatformIntegration(platformIntegration, user.id))) {
      await unlinkKiloUser(chatBot.getState(), identity);
      await botPlatform.promptLinkAccount({
        thread,
        message,
        identity,
        platformIntegration,
        state: chatBot.getState(),
      });
      return;
    }

    try {
      await processLinkedMessage({ thread, message, platformIntegration, user });
    } catch (error) {
      console.error('[Bot] Unhandled error in message handler:', error);
      await thread.post({ markdown: 'Sorry, something went wrong while processing your message.' });
    }
  });

  chatBot.onAction(async event => {
    await botPlatforms.getByAdapter(event.adapter)?.handleAction?.(event);
  });

  chatBot.onAssistantThreadStarted(async event => {
    await botPlatforms.getByAdapter(event.adapter)?.handleAssistantThreadStarted?.(event);
  });

  chatBot.onMemberJoinedChannel(async event => {
    await botPlatforms.getByAdapter(event.adapter)?.handleMemberJoinedChannel?.(event);
  });

  chatBot.onAppHomeOpened(async event => {
    await botPlatforms.getByAdapter(event.adapter)?.handleAppHomeOpened?.(event);
  });

  return chatBot;
}

export const bot = createKiloBot(slackAdapter, githubAdapter, linearAdapter);

// registerSingleton is synchronous and idempotent and is required for
// ThreadImpl.fromJSON deserialization. Doing it once at module load means
// callers don't need to repeat it on every request.
bot.registerSingleton();

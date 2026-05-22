import { Chat, type Message, type Thread } from 'chat';
import type { GitHubAdapter } from '@chat-adapter/github';
import type { LinearAdapter } from '@chat-adapter/linear';
import type { SlackAdapter } from '@chat-adapter/slack';
import { handleIncomingBotMention } from '@/lib/bot/handle-mention';
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
    await handleIncomingBotMention({ thread, message, state: chatBot.getState() });
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

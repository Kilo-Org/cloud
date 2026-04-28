import { Chat, type ActionEvent, type Message, type Thread } from 'chat';
import { createSlackAdapter, SlackAdapter } from '@chat-adapter/slack';
import { captureException } from '@sentry/nextjs';
import { resolveKiloUserId, unlinkKiloUser } from '@/lib/bot-identity';
import { getPlatformIdentity, getPlatformIntegration } from '@/lib/bot/platform-helpers';
import { LINK_ACCOUNT_ACTION_PREFIX, promptLinkAccount } from '@/lib/bot/link-account';
import { createBotRequest, updateBotRequest } from '@/lib/bot/request-logging';
import { findUserById } from '@/lib/user';
import { processMessage } from '@/lib/bot/run';
import { createChatState } from '@/lib/bot/state';
import { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET } from '@/lib/config.server';

const SLACK_ASSISTANT_SUGGESTED_PROMPTS = [
  {
    title: 'Fix an issue in my codebase',
    message: 'Please ask me for the link to an issue that I want you to fix.',
  },
  {
    title: 'Fix a bug',
    message: 'Help me investigate and fix a bug in my codebase.',
  },
  {
    title: 'Review code',
    message: 'Please ask me for a PR that you should review',
  },
  {
    title: 'Explain Kilo Bot',
    message: 'What can Kilo Bot do from Slack, and how do I get started?',
  },
] as const;

const ASSISTANT_PROMPTS_TITLE = 'Try asking Kilo Bot';

function createKiloBot(slackAdapter: ReturnType<typeof createSlackAdapter>) {
  const chatBot = new Chat({
    userName: process.env.NODE_ENV === 'production' ? 'Kilo' : 'Henk',
    adapters: {
      slack: slackAdapter,
    },
    state: createChatState(),
  });

  chatBot.onNewMention(async function handleIncomingMessage(
    thread: Thread,
    message: Message
  ): Promise<void> {
    const identity = getPlatformIdentity(thread, message);
    const [platformIntegration, kiloUserId] = await Promise.all([
      getPlatformIntegration(thread, message),
      resolveKiloUserId(chatBot.getState(), identity),
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
      await unlinkKiloUser(chatBot.getState(), identity);
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

    chatBot.registerSingleton();

    await thread.startTyping('Thinking...');

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
  chatBot.onAction(async function handleLinkAccountClick(event: ActionEvent): Promise<void> {
    if (!event.actionId.startsWith(LINK_ACCOUNT_ACTION_PREFIX)) return;

    try {
      await event.adapter.deleteMessage(event.threadId, event.messageId);
    } catch (error) {
      // Not critical — the ephemeral message will disappear on its own eventually
      console.warn('[Bot] Failed to delete link-account ephemeral:', error);
    }
  });

  chatBot.onAssistantThreadStarted(async event => {
    if (event.adapter instanceof SlackAdapter) {
      try {
        await event.adapter.setSuggestedPrompts(
          event.channelId,
          event.threadTs,
          [...SLACK_ASSISTANT_SUGGESTED_PROMPTS],
          ASSISTANT_PROMPTS_TITLE
        );
      } catch (error) {
        console.error('[Bot] Failed to set suggested prompts:', error);
        captureException(error, {
          tags: { component: 'kilo-bot', op: 'assistant-thread-started' },
          extra: { userId: event.userId, channelId: event.channelId },
        });
      }
    }
  });

  return chatBot;
}

const slackAdapter = createSlackAdapter({
  clientId: SLACK_CLIENT_ID,
  clientSecret: SLACK_CLIENT_SECRET,
  signingSecret: SLACK_SIGNING_SECRET,
});

export const bot = createKiloBot(slackAdapter);

import { Chat, type ActionEvent, type Message, type Thread } from 'chat';
import { createSlackAdapter, SlackAdapter } from '@chat-adapter/slack';
import { captureException } from '@sentry/nextjs';
import type { HomeView } from '@slack/types';
import { resolveKiloUserId, unlinkKiloUser } from '@/lib/bot-identity';
import { isSlackMissingScopeError, postSlackReinstallInstruction } from '@/lib/bot/helpers';
import {
  getPlatformIdentity,
  getPlatformIntegration,
  getPlatformIntegrationByBotUserId,
} from '@/lib/bot/platform-helpers';
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

export function buildSlackAppHomeView() {
  return {
    type: 'home',
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: 'Welcome to Kilo Bot', emoji: true },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Turn Slack messages into focused coding work. Ask Kilo to investigate bugs, review pull requests, explain code, or start a Cloud Agent session in your connected repositories.',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Read the docs', emoji: true },
            url: 'https://kilo.ai/docs/advanced-usage/slackbot',
            action_id: 'kilo_bot_home_docs',
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Open Kilo', emoji: true },
            url: 'https://app.kilo.ai',
            action_id: 'kilo_bot_home_app',
            style: 'primary',
          },
        ],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*What you can ask me to do*' },
      },
      {
        type: 'section',
        fields: [
          {
            type: 'mrkdwn',
            text: '*Fix issues*\nPaste an issue link or describe a bug and I can investigate the codebase.',
          },
          {
            type: 'mrkdwn',
            text: '*Review PRs*\nSend a pull request link and ask for risks, regressions, or missing tests.',
          },
          {
            type: 'mrkdwn',
            text: '*Make changes*\nAsk for implementation work and I can start a Cloud Agent session.',
          },
          {
            type: 'mrkdwn',
            text: '*Answer questions*\nAsk about repo structure, code behavior, or how to use Kilo from Slack.',
          },
        ],
      },
      { type: 'divider' },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Try these prompts*' },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '• `Fix this issue: <issue link>`\n• `Review this PR for bugs: <PR link>`\n• `Implement <feature> in <repo>`\n• `Explain how <component> works`',
        },
      },
      { type: 'divider' },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: 'Tip: If your Slack account is not linked yet, mention Kilo or send a message and I will provide a secure link prompt.',
          },
        ],
      },
    ],
  } satisfies HomeView;
}

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
    if (!(event.adapter instanceof SlackAdapter)) return;

    try {
      await event.adapter.setSuggestedPrompts(
        event.channelId,
        event.threadTs,
        [...SLACK_ASSISTANT_SUGGESTED_PROMPTS],
        ASSISTANT_PROMPTS_TITLE
      );
    } catch (error) {
      if (isSlackMissingScopeError(error)) {
        const platformIntegration = await getPlatformIntegrationByBotUserId(
          event.adapter.name,
          event.adapter.botUserId
        );
        console.error('[Bot] Missing scope:', error.data.needed);
        await postSlackReinstallInstruction(
          event.adapter,
          event.threadId,
          error.data.needed,
          platformIntegration
        );
      } else {
        console.error('[Bot] Failed to set suggested prompts:', error);
        captureException(error, {
          tags: { component: 'kilo-bot', op: 'assistant-thread-started' },
          extra: { userId: event.userId, channelId: event.channelId },
        });
      }
    }
  });

  chatBot.onAppHomeOpened(async event => {
    if (!(event.adapter instanceof SlackAdapter)) return;

    try {
      await event.adapter.publishHomeView(event.userId, buildSlackAppHomeView());
    } catch (error) {
      console.error('[Bot] Failed to publish Slack App Home:', error);
      captureException(error, {
        tags: { component: 'kilo-bot', op: 'app-home-opened' },
        extra: { userId: event.userId, channelId: event.channelId },
      });
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

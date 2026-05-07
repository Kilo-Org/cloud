import { createLinkAccountToken } from '@/lib/bot-identity';
import { isSlackMissingScopeError, postSlackReinstallInstruction } from '@/lib/bot/helpers';
import { getPlatformIntegrationByBotUserId } from '@/lib/bot/platform-helpers';
import {
  collectMessages,
  type ContextTriggerMessage,
  formatMessage,
  formatUserMessage,
  MAX_MESSAGE_TEXT_LENGTH,
  sanitizeForDelimiters,
  truncate,
} from '@/lib/bot/platforms/shared';
import type { BotPlatform, RequesterInfo } from '@/lib/bot/platforms/types';
import { BOT_CONTEXT_MESSAGE_LIMIT } from '@/lib/bot/constants';
import { APP_URL } from '@/lib/constants';
import { getAccessTokenFromInstallation } from '@/lib/integrations/slack-service';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getSlackMessagePermalink } from '@/lib/slack-bot/slack-utils';
import { captureException } from '@sentry/nextjs';
import { SlackAdapter, type SlackEvent } from '@chat-adapter/slack';
import type { PlatformIntegration } from '@kilocode/db';
import type { HomeView } from '@slack/types';
import { WebClient } from '@slack/web-api';
import {
  Actions,
  Card,
  CardText,
  LinkButton,
  type ActionEvent,
  type ChannelInfo,
  type Message,
  type Thread,
} from 'chat';

const LINK_ACCOUNT_PATH = '/api/chat/link-account';

const LINK_ACCOUNT_ACTION_PREFIX = `link-${APP_URL}${LINK_ACCOUNT_PATH}`;

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

const SLACK_CHANNEL_INVITE_MESSAGE = {
  markdown:
    "Hey, I'm Kilo, an AI coding assistant. Mention me in this channel when you want help investigating bugs, reviewing PRs, explaining code, or starting implementation work. AI can make mistakes, so please review responses before relying on them. Sessions created with Kilo from Slack are stored at https://app.kilo.ai.",
} as const;

function linkAccountCard(linkUrl: string) {
  return Card({
    title: 'Link your Kilo account',
    children: [
      CardText(
        'To use Kilo from this workspace you first need to link your chat account. ' +
          'Click the button below to sign in and link your account.'
      ),
      Actions([LinkButton({ label: 'Link Account', url: linkUrl, style: 'primary' })]),
    ],
  });
}

function buildSlackAppHomeView() {
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
          text: "I'm Kilo, an AI coding assistant that turns Slack messages into focused coding work. Ask me to investigate bugs, review pull requests, explain code, or start a Cloud Agent session in your connected repositories. AI can make mistakes, so please review responses before relying on them. Sessions created with Kilo from Slack are stored at https://app.kilo.ai.",
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

async function getSlackConversationContext(
  thread: Thread,
  triggerMessage: ContextTriggerMessage
): Promise<string> {
  const [channelInfo, threadMessagesRaw, channelMessagesRaw] = await Promise.all([
    thread.channel.fetchMetadata().catch((): ChannelInfo | null => null),
    collectMessages(thread.messages, BOT_CONTEXT_MESSAGE_LIMIT).catch((): Message[] => []),
    collectMessages(thread.channel.messages, BOT_CONTEXT_MESSAGE_LIMIT).catch((): Message[] => []),
  ]);

  const threadMessages = threadMessagesRaw
    .filter(m => m.id !== triggerMessage.id)
    .map(m => formatMessage(m))
    .reverse();

  const channelMessages = channelMessagesRaw
    .filter(m => m.id !== triggerMessage.id)
    .map(m => formatMessage(m))
    .reverse();

  const metadata = channelInfo?.metadata ?? {};
  const channelTopic = typeof metadata.topic === 'string' ? metadata.topic : null;
  const channelPurpose = typeof metadata.purpose === 'string' ? metadata.purpose : null;

  const lines: string[] = ['Slack conversation context:'];
  const name = channelInfo?.name?.replace(/^#/, '');
  const channelLabel = (channelInfo?.isDM ?? thread.isDM) ? 'DM' : name ? `#${name}` : 'channel';
  lines.push(`- Channel: ${channelLabel}`);

  if (channelTopic) {
    lines.push(
      `- Channel topic: ${sanitizeForDelimiters(truncate(channelTopic, MAX_MESSAGE_TEXT_LENGTH))}`
    );
  }
  if (channelPurpose) {
    lines.push(
      `- Channel purpose: ${sanitizeForDelimiters(truncate(channelPurpose, MAX_MESSAGE_TEXT_LENGTH))}`
    );
  }

  if (channelMessages.length > 0) {
    lines.push('', 'Recent channel messages (oldest first):');
    for (const msg of channelMessages) lines.push(formatUserMessage(msg));
  }

  if (threadMessages.length > 0) {
    lines.push('', 'Thread messages (oldest first):');
    for (const msg of threadMessages) lines.push(formatUserMessage(msg));
  }

  if (lines.length <= 2 && channelMessages.length === 0) return '';
  return lines.join('\n');
}

async function getSlackRequesterInfo(
  message: Message,
  platformIntegration: PlatformIntegration,
  displayName: string
): Promise<RequesterInfo> {
  const accessToken = getAccessTokenFromInstallation(platformIntegration);
  if (!accessToken) {
    return { displayName, platform: PLATFORM.SLACK };
  }

  const { channel: channelId } = (message as Message<SlackEvent>).raw;
  const messageTs = message.id;

  if (!channelId || !messageTs) {
    return { displayName, platform: PLATFORM.SLACK };
  }

  const slackClient = new WebClient(accessToken);
  const permalink = await getSlackMessagePermalink(slackClient, channelId, messageTs);

  return { displayName, messageLink: permalink, platform: PLATFORM.SLACK };
}

export function createSlackBotPlatform(slackAdapter: SlackAdapter): BotPlatform {
  return {
    platform: PLATFORM.SLACK,
    documentationUrl: 'https://kilo.ai/docs/code-with-ai/platforms/slack',
    usesGenericLinkAccountRoute: true,
    async getIdentity({ message }) {
      const { team_id, team } = (message as Message<SlackEvent>).raw;
      const teamId = team_id ?? team;
      if (!teamId) {
        throw new Error('Expected a teamId in message.raw');
      }
      return {
        platform: PLATFORM.SLACK,
        teamId,
        userId: message.author.userId,
      };
    },
    isEnabledForBot: () => true,
    canHandleMessage: () => true,
    async promptLinkAccount({ thread, message, identity, state }) {
      const { thread_ts, ts } = (message as Message<SlackEvent>).raw;
      const isChannelLevel = !thread_ts || thread_ts === ts;
      const target = isChannelLevel ? thread.channel : thread;
      const url = new URL(LINK_ACCOUNT_PATH, APP_URL);
      url.searchParams.set(
        'token',
        await createLinkAccountToken({
          identity,
          thread: thread.toJSON(),
          message: message.toJSON(),
          state,
        })
      );
      await target.postEphemeral(message.author, linkAccountCard(url.toString()), {
        fallbackToDM: true,
      });
    },
    async withAuthContext({ platformIntegration, fn }) {
      const platformAccountId = platformIntegration.platform_account_id;
      if (!platformAccountId) {
        throw new Error(`No Slack account id for platform integration ${platformIntegration.id}`);
      }

      const installation = await slackAdapter.getInstallation(platformAccountId);
      if (!installation) {
        throw new Error(`No Slack installation for platform integration ${platformIntegration.id}`);
      }

      return await slackAdapter.withBotToken(installation.botToken, fn);
    },
    async getConversationContext({ thread, triggerMessage }) {
      return await getSlackConversationContext(thread, triggerMessage);
    },
    async getRequesterInfo({ message, platformIntegration, displayName }) {
      return await getSlackRequesterInfo(message, platformIntegration, displayName);
    },
    // When the user clicks the "Link Account" LinkButton, Slack fires a
    // block_actions event *in addition to* opening the URL in the browser.
    // For ephemeral messages the adapter encodes the response_url into the
    // messageId, so deleteMessage sends `{ delete_original: true }` — removing
    // the ephemeral card from the user's view.
    async handleAction(event: ActionEvent) {
      if (!event.actionId.startsWith(LINK_ACCOUNT_ACTION_PREFIX)) return;

      try {
        await event.adapter.deleteMessage(event.threadId, event.messageId);
      } catch (error) {
        // Not critical — the ephemeral message will disappear on its own eventually
        console.warn('[Bot] Failed to delete link-account ephemeral:', error);
      }
    },
    async handleAssistantThreadStarted({ adapter, channelId, threadTs, threadId, userId }) {
      if (!(adapter instanceof SlackAdapter)) return;

      try {
        await adapter.setSuggestedPrompts(
          channelId,
          threadTs,
          [...SLACK_ASSISTANT_SUGGESTED_PROMPTS],
          ASSISTANT_PROMPTS_TITLE
        );
      } catch (error) {
        if (isSlackMissingScopeError(error)) {
          const platformIntegration = await getPlatformIntegrationByBotUserId(
            adapter.name,
            adapter.botUserId
          );
          console.error('[Bot] Missing scope:', error.data.needed);
          await postSlackReinstallInstruction(
            adapter,
            threadId,
            error.data.needed,
            platformIntegration
          );
        } else {
          console.error('[Bot] Failed to set suggested prompts:', error);
          captureException(error, {
            tags: { component: 'kilo-bot', op: 'assistant-thread-started' },
            extra: { userId, channelId },
          });
        }
      }
    },
    async handleMemberJoinedChannel({ adapter, userId, channelId, inviterId }) {
      if (!(adapter instanceof SlackAdapter)) return;
      if (userId !== adapter.botUserId) return;

      try {
        await adapter.postMessage(channelId, SLACK_CHANNEL_INVITE_MESSAGE);
      } catch (error) {
        console.error('[Bot] Failed to post Slack channel invite message:', error);
        captureException(error, {
          tags: { component: 'kilo-bot', op: 'member-joined-channel' },
          extra: { channelId, inviterId, userId },
        });
      }
    },
    async handleAppHomeOpened({ adapter, userId, channelId }) {
      if (!(adapter instanceof SlackAdapter)) return;

      try {
        await adapter.publishHomeView(userId, buildSlackAppHomeView());
      } catch (error) {
        console.error('[Bot] Failed to publish Slack App Home:', error);
        captureException(error, {
          tags: { component: 'kilo-bot', op: 'app-home-opened' },
          extra: { userId, channelId },
        });
      }
    },
  };
}

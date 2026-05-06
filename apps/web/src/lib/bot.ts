import crypto from 'node:crypto';
import { Chat, type ActionEvent, type Message, type Thread, type WebhookOptions } from 'chat';
import { createGitHubAdapter, type GitHubAdapter } from '@chat-adapter/github';
import { createSlackAdapter, SlackAdapter } from '@chat-adapter/slack';
import { captureException } from '@sentry/nextjs';
import type { HomeView } from '@slack/types';
import { resolveKiloUserId, unlinkKiloUser, unlinkTeamKiloUsers } from '@/lib/bot-identity';
import { isSlackMissingScopeError, postSlackReinstallInstruction } from '@/lib/bot/helpers';
import { deleteInstallationByTeamId } from '@/lib/integrations/slack-service';
import {
  getGitHubRepositoryReference,
  getPlatformIdentity,
  getPlatformIntegration,
  getPlatformIntegrationByBotUserId,
  isGitHubBotEnabled,
  isGitHubRepositoryLinked,
} from '@/lib/bot/platform-helpers';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { LINK_ACCOUNT_ACTION_PREFIX, promptLinkAccount } from '@/lib/bot/link-account';
import { findUserById } from '@/lib/user';
import { processLinkedMessage } from '@/lib/bot/run';
import { createChatState } from '@/lib/bot/state';
import { SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, SLACK_SIGNING_SECRET } from '@/lib/config.server';
import { getGitHubAppCredentials } from '@/lib/integrations/platforms/github/app-selector';

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

const SLACK_SIGNATURE_VERSION = 'v0';
const SLACK_SIGNATURE_TOLERANCE_SECONDS = 60 * 5;

const SLACK_CHANNEL_INVITE_MESSAGE = {
  markdown:
    "Hey, I'm Kilo, an AI coding assistant. Mention me in this channel when you want help investigating bugs, reviewing PRs, explaining code, or starting implementation work. AI can make mistakes, so please review responses before relying on them. Sessions created with Kilo from Slack are stored at https://app.kilo.ai.",
} as const;

type SlackAppUninstalledPayload = {
  type: 'event_callback';
  team_id: string;
  event: {
    type: 'app_uninstalled';
  };
};

function verifySlackSignature(body: string, request: Request): boolean {
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');

  if (!timestamp || !signature) return false;

  const timestampSeconds = Number.parseInt(timestamp, 10);
  if (Number.isNaN(timestampSeconds)) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > SLACK_SIGNATURE_TOLERANCE_SECONDS) {
    return false;
  }

  const signatureBaseString = `${SLACK_SIGNATURE_VERSION}:${timestamp}:${body}`;
  const expectedSignature = `${SLACK_SIGNATURE_VERSION}=${crypto
    .createHmac('sha256', SLACK_SIGNING_SECRET)
    .update(signatureBaseString)
    .digest('hex')}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
  } catch {
    return false;
  }
}

function isSlackAppUninstalledPayload(payload: unknown): payload is SlackAppUninstalledPayload {
  return (
    !!payload &&
    typeof payload === 'object' &&
    'type' in payload &&
    payload.type === 'event_callback' &&
    'team_id' in payload &&
    typeof payload.team_id === 'string' &&
    'event' in payload &&
    !!payload.event &&
    typeof payload.event === 'object' &&
    'type' in payload.event &&
    payload.event.type === 'app_uninstalled'
  );
}

async function handleSlackAppUninstalled(teamId: string, chatBot: Chat): Promise<void> {
  try {
    await deleteInstallationByTeamId(teamId);
    await slackAdapter.deleteInstallation(teamId);
    await unlinkTeamKiloUsers(chatBot.getState(), 'slack', teamId);
  } catch (error) {
    captureException(error, {
      level: 'error',
      tags: { component: 'kilo-bot', op: 'slack-app-uninstalled' },
      extra: { teamId },
    });
  }
}

async function handleSlackWebhook(
  request: Request,
  options: WebhookOptions | undefined,
  chatBot: Chat,
  slackAdapter: SlackAdapter
): Promise<Response> {
  const body = await request.text();

  if (!verifySlackSignature(body, request)) {
    return new Response('Invalid signature', { status: 401 });
  }

  await chatBot.initialize();

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return slackAdapter.handleWebhook(cloneSlackRequest(request, body), options);
  }

  if (isSlackAppUninstalledPayload(payload)) {
    try {
      await handleSlackAppUninstalled(payload.team_id, chatBot);
    } catch (error) {
      console.error('[Bot] Failed to handle Slack app_uninstalled event:', error);
      captureException(error, {
        tags: { component: 'kilo-bot', op: 'slack-app-uninstalled' },
        extra: { teamId: payload.team_id },
      });
    }

    return new Response('ok', { status: 200 });
  }

  return slackAdapter.handleWebhook(cloneSlackRequest(request, body), options);
}

function cloneSlackRequest(request: Request, body: BodyInit): Request {
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
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

function createKiloBot(
  slackAdapter: ReturnType<typeof createSlackAdapter>,
  githubAdapter: GitHubAdapter
) {
  const chatBot = new Chat({
    userName: process.env.NODE_ENV === 'production' ? 'Kilo' : 'Henk',
    adapters: {
      github: githubAdapter,
      slack: slackAdapter,
    },
    state: createChatState(),
    logger: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
  });

  chatBot.webhooks.slack = (request, options) =>
    handleSlackWebhook(request, options, chatBot, slackAdapter);

  chatBot.onNewMention(async function handleIncomingMessage(
    thread: Thread,
    message: Message
  ): Promise<void> {
    const identity = await getPlatformIdentity(thread, message, githubThread =>
      githubAdapter.getInstallationId(githubThread)
    );
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

    // Canary gate: the GitHub bot path is opt-in per integration via
    // `metadata.bot_enabled`. Webhooks still arrive at the adapter so this
    // handler runs, but we drop out before any user-visible side effects
    // (no link prompt, no agent run, no GitHub API calls).
    if (identity.platform === PLATFORM.GITHUB && !isGitHubBotEnabled(platformIntegration)) {
      return;
    }

    if (
      identity.platform === PLATFORM.GITHUB &&
      !isGitHubRepositoryLinked(platformIntegration, getGitHubRepositoryReference(thread, message))
    ) {
      return;
    }

    if (!kiloUserId) {
      await promptLinkAccount(thread, message, identity, platformIntegration, chatBot.getState());
      return;
    }

    const user = await findUserById(kiloUserId);

    if (!user) {
      await unlinkKiloUser(chatBot.getState(), identity);
      await promptLinkAccount(thread, message, identity, platformIntegration, chatBot.getState());
      return;
    }

    chatBot.registerSingleton();

    try {
      await processLinkedMessage({ thread, message, platformIntegration, user });
    } catch (error) {
      console.error('[Bot] Unhandled error in message handler:', error);
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

  chatBot.onMemberJoinedChannel(async event => {
    if (!(event.adapter instanceof SlackAdapter)) return;
    if (event.userId !== event.adapter.botUserId) return;

    try {
      await event.adapter.postMessage(event.channelId, SLACK_CHANNEL_INVITE_MESSAGE);
    } catch (error) {
      console.error('[Bot] Failed to post Slack channel invite message:', error);
      captureException(error, {
        tags: { component: 'kilo-bot', op: 'member-joined-channel' },
        extra: {
          channelId: event.channelId,
          inviterId: event.inviterId,
          userId: event.userId,
        },
      });
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

const githubAppCredentials = getGitHubAppCredentials('standard');
const githubAdapter = createGitHubAdapter({
  appId: githubAppCredentials.appId,
  privateKey: githubAppCredentials.privateKey,
  webhookSecret: githubAppCredentials.webhookSecret,
  userName: process.env.NODE_ENV === 'development' ? 'kilocode-dev' : 'kilocode-bot',
});

export const bot = createKiloBot(slackAdapter, githubAdapter);

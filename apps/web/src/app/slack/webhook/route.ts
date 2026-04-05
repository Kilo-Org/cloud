import type { NextRequest } from 'next/server';
import { after, NextResponse } from 'next/server';
import type { AppMentionEvent, GenericMessageEvent } from '@slack/types';
import { WebClient } from '@slack/web-api';
import { processKiloBotMessage } from '@/lib/slack-bot';
import { markdownToSlackMrkdwn } from '@/lib/slack/markdownToSlackMrkdwn';
import { logSlackBotRequest } from '@/lib/slack-bot-logging';
import {
  getInstallationByTeamId,
  getAccessTokenFromInstallation,
  getOwnerFromInstallation,
  addSlackReactionByAccessToken,
  removeSlackReactionByAccessToken,
  postSlackMessageByAccessToken,
} from '@/lib/integrations/slack-service';
import {
  stripSlackBotMention,
  getSlackBotUserIdFromInstallation,
  replaceSlackUserMentionsWithNames,
  isExternalWorkspaceEvent,
} from '@/lib/slack-bot/slack-utils';
import { getDevUserSuffix } from '@/lib/slack-bot/dev-user-info';
import {
  buildSessionUrl,
  getDbSessionIdFromCloudAgentId,
} from '@/lib/cloud-agent-next/session-url';
import { verifySlackRequest } from '@/lib/slack/verify-request';

import type { PlatformIntegration } from '@kilocode/db/schema';

export const maxDuration = 800;

/**
 * Reaction emoji names
 */
const PROCESSING_REACTION = 'hourglass_flowing_sand';
const COMPLETE_REACTION = 'white_check_mark';

/**
 * Post an ephemeral message to the user with a button to view the cloud agent session
 */
async function postSessionLinkEphemeral({
  accessToken,
  channel,
  user,
  threadTs,
  cloudAgentSessionId,
  installation,
}: {
  accessToken: string;
  channel: string;
  user: string;
  threadTs: string;
  cloudAgentSessionId: string;
  installation: PlatformIntegration;
}): Promise<void> {
  const owner = getOwnerFromInstallation(installation);
  if (!owner) {
    console.error('[SlackBot:Webhook] Could not determine owner for session link');
    return;
  }

  // Look up the database session UUID from the cloud agent session ID
  const dbSessionId = await getDbSessionIdFromCloudAgentId(cloudAgentSessionId);
  if (!dbSessionId) {
    console.error(
      '[SlackBot:Webhook] Could not find database session for cloud agent session:',
      cloudAgentSessionId
    );
    return;
  }

  const sessionUrl = buildSessionUrl(dbSessionId, owner);

  const client = new WebClient(accessToken);
  await client.chat.postEphemeral({
    channel,
    user,
    text: `View the Cloud Agent session: ${sessionUrl}`,
    thread_ts: threadTs,
    blocks: [
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'View Session',
              emoji: true,
            },
            value: 'view_session',
            url: sessionUrl,
          },
        ],
      },
    ],
  });
}

/**
 * Slack Events API webhook handler
 * Handles @mentions of the bot and responds in threads
 */
export async function POST(request: NextRequest) {
  console.log('[SlackBot:Webhook] POST request received');

  const rawBody = await request.text();
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');

  if (!verifySlackRequest(rawBody, timestamp, signature)) {
    console.error('[SlackBot:Webhook] Invalid Slack signature');
    return new NextResponse('Invalid signature', { status: 401 });
  }

  const body = JSON.parse(rawBody);

  // Handle Slack URL verification challenge
  // This is required when first setting up the Events API
  if (body.type === 'url_verification') {
    console.log('[SlackBot:Webhook] URL verification challenge received');
    return NextResponse.json({ challenge: body.challenge });
  }

  // Handle event callbacks
  if (body.type === 'event_callback') {
    const event = body.event;
    const teamId = body.team_id as string;
    console.log('[SlackBot:Webhook] Event received:', event?.type, 'from team:', teamId);

    if (isExternalWorkspaceEvent(event)) {
      console.log('[SlackBot:Webhook] Event is from an external user, ignoring');
      return new NextResponse(null, { status: 200 });
    }

    // Handle app_mention events (ignore messages from bots)
    if (event?.type === 'app_mention' && !event.bot_id) {
      after(processSlackMessage(event, teamId));
      return new NextResponse(null, { status: 200 });
    }

    // Handle message events in channels/DMs (optional, for future expansion)
    if (event?.type === 'message' && !event.bot_id && event.channel_type === 'im') {
      after(processSlackMessage(event, teamId));
      return new NextResponse(null, { status: 200 });
    }
  }

  // Return 200 for any other events to acknowledge receipt
  return new NextResponse(null, { status: 200 });
}

/**
 * Process a Slack message event (either @mention or direct message)
 */
async function processSlackMessage(event: AppMentionEvent | GenericMessageEvent, teamId: string) {
  console.log(`[SlackBot:Webhook] processSlackMessage (${event.type} started for team:`, teamId);
  console.log('[SlackBot:Webhook] Event data:', JSON.stringify(event, null, 2));

  // Fetch the installation and access token once at the start
  const installation = await getInstallationByTeamId(teamId);
  if (!installation) {
    console.error('[SlackBot:Webhook] No Slack installation found for team:', teamId);
    return;
  }

  const accessToken = getAccessTokenFromInstallation(installation);
  if (!accessToken) {
    console.error('[SlackBot:Webhook] No access token found for team:', teamId);
    return;
  }

  const startTime = Date.now();
  const { text, channel, ts, thread_ts, user } = event;

  const botUserId = getSlackBotUserIdFromInstallation(installation);

  // Remove only the bot's mention; keep other user mentions for context
  // Slack mentions look like <@U123ABC456> or <@U123ABC456|username>
  const cleanedText = stripSlackBotMention(text, botUserId);

  if (!cleanedText) {
    console.log('[SlackBot:Webhook] No text after removing mention, ignoring');
    return;
  }

  // Resolve user mentions to human-readable names
  const client = new WebClient(accessToken);
  const kiloInputText = await replaceSlackUserMentionsWithNames(client, cleanedText);

  console.log('[SlackBot:Webhook] Cleaned text:', kiloInputText);

  // Determine the thread to reply to
  // If the mention was in a thread, reply there; otherwise reply to the original message
  const replyThreadTs = thread_ts ?? ts;

  // Add a "processing" reaction to the original message
  await addSlackReactionByAccessToken(accessToken, {
    channel,
    timestamp: ts,
    name: PROCESSING_REACTION,
  });

  // Process the message through Kilo Bot
  const result = await processKiloBotMessage(kiloInputText, teamId, {
    channelId: channel,
    threadTs: replyThreadTs,
    userId: user as string,
    messageTs: ts,
  });
  const responseTimeMs = Date.now() - startTime;

  // Append dev user suffix if in dev environment
  const responseWithDevInfo = result.response + getDevUserSuffix();
  const slackFormattedMessage = markdownToSlackMrkdwn(responseWithDevInfo);

  // Post the response in the thread
  const slackResponse = await postSlackMessageByAccessToken(accessToken, {
    channel,
    text: slackFormattedMessage,
    thread_ts: replyThreadTs,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: slackFormattedMessage,
        },
      },
    ],
  });

  console.log(
    '[SlackBot:Webhook] Slack response:',
    slackResponse.ok ? 'success' : slackResponse.error
  );

  // Replace the processing reaction with a complete reaction
  await Promise.all([
    removeSlackReactionByAccessToken(accessToken, {
      channel,
      timestamp: ts,
      name: PROCESSING_REACTION,
    }),
    addSlackReactionByAccessToken(accessToken, {
      channel,
      timestamp: ts,
      name: COMPLETE_REACTION,
    }),
  ]);

  // If a cloud agent session was created, post an ephemeral button for the user to view it
  if (result.cloudAgentSessionId && user) {
    await postSessionLinkEphemeral({
      accessToken,
      channel,
      user,
      threadTs: replyThreadTs,
      cloudAgentSessionId: result.cloudAgentSessionId,
      installation,
    });
  }

  // Log the request for admin debugging
  await logSlackBotRequest({
    slackTeamId: teamId,
    slackTeamName: installation?.platform_account_login ?? undefined,
    slackChannelId: channel,
    slackUserId: user ?? 'unknown',
    slackThreadTs: replyThreadTs,
    eventType: event.type,
    userMessage: kiloInputText,
    status: result.error ? 'error' : 'success',
    errorMessage: result.error,
    responseTimeMs,
    modelUsed: result.modelUsed,
    toolCallsMade: result.toolCallsMade.length > 0 ? result.toolCallsMade : undefined,
    cloudAgentSessionId: result.cloudAgentSessionId,
    integration: installation,
  });

  console.log(`[SlackBot:Webhook] processSlackMessage (${event.type}) completed`);
}
